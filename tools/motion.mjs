// vf motion: คลิปการ์ตูนมุกสั้น (20–180 วินาที) จากท่าตัวละครที่ตัดไว้แล้ว + GSAP บน HyperFrames — ไม่ใช้โมเดลวิดีโอ
// LLM เขียน JSON สองรอบ (story → scenes) → prop ที่ขาด → TTS ทุกบท (ตัดเงียบ + วัดความดังต่อเฟรม)
// → index.html แบบ deterministic → lint → snapshot ให้ clef ตรวจ (เตือนอย่างเดียว) → render วิดีโอเงียบ → เสียง + mix
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parse, VfError, log } from "./out.mjs";
import { resolveProject, slugify } from "./paths.mjs";
import { llmJson } from "./llm.mjs";
import { openState, step, writeJsonAtomic, readJson } from "./state.mjs";
import { recordEpisode } from "./bible.mjs";
import { MODELS } from "./models.mjs";
import { estimate } from "./pricing.mjs";
import { sha } from "./project-create.mjs";
import { tts } from "./audio.mjs";
import { clef, toQaImage } from "./qa.mjs";
import { LIBRARY_TRACK_SEC } from "./music-lib.mjs";
import { ffmpeg } from "./assemble.mjs";
import { SFX_KINDS } from "./fx.mjs";
import { pool } from "./shots.mjs";
import { loadPoses } from "./poses.mjs";
import { listProps, makeProp } from "./props.mjs";
import { stageFor, upgradeStage } from "./stage.mjs";
import { STORY_SCHEMA, storySystemPrompt, validateStory, scenesSchema, scenesSystemPrompt, validateScenePlan, normalizeScenePlan } from "./motion-plan.mjs";
import { FONT_FOR, fontFile, sceneTimes, audioCues, composeHtml } from "./hf-compose.mjs";
import { gsapFile, hfLint, hfSnapshot, hfRender } from "./hf.mjs";
import { COMMON_OPTIONS, parseCommon, finishAudio } from "./longform.mjs";
import { pinInput, pinRun, costSince, contextMessage, loadProject, planRows, llmRow, qaRow, runEntity } from "./entities.mjs";

const execFileP = promisify(execFile);

export const FPS = 30;
export const SIZE = { w: 1080, h: 1920 };
export const CONCURRENCY = 3;
export const STAGING_QUESTION = "Is any character standing on furniture, cut off by the frame edge, or floating in the air?";
export const STAGING_WARN = 0.5;
const STAGING_KEY = "staging_problem";
const STAGING_STATE = "One frame from a kids' cartoon made of cut-out characters on a painted background.";
// TTS มีเงียบหัวท้าย: ตัดออกก่อนวัดเวลา ไม่งั้นปากขยับช้ากว่าเสียงและฉากยาวเกิน
const TRIM = "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse";
const RMS_RATE = 8000;
const PCM_TIMEOUT_MS = 2 * 60 * 1000;

// flag ของ motion แบบเก่า: ยังรับไว้ไม่ให้ skill เดิมพัง แต่ไม่มีผล
const OPTIONS = { ...COMMON_OPTIONS, "no-reuse": { type: "boolean" } };
const IGNORED = {
  "no-reuse": "--no-reuse ไม่มีผลแล้ว (motion แบบใหม่ไม่ใช้ภาพนิ่งจากคลัง)",
  "max-rerolls": "--max-rerolls ไม่มีผลกับ motion แบบใหม่ (ใช้ท่าตัวละครที่ทำไว้แล้ว)",
};
const ignoredWarnings = (values) => Object.keys(IGNORED).filter((k) => values[k] !== undefined).map((k) => IGNORED[k]);

const r3 = (v) => Math.round(v * 1000) / 1000;
const lineKey = (si, li) => `${si + 1}-${li + 1}`;

// สถานที่ที่ใช้ได้ = มีภาพฉาก (plate) จริง
function usablePlaces(dir, places) {
  return places.filter((p) => {
    const pj = readJson(join(dir, "places", p.id, "place.json"), null);
    return pj?.plate && existsSync(join(dir, "places", p.id, pj.plate));
  });
}

function platePath(dir, placeId) {
  const pj = readJson(join(dir, "places", placeId, "place.json"));
  return join(dir, "places", placeId, pj.plate);
}

function voiceOf(dir, pj, who) {
  if (who === "narrator") return pj.narrator_voice || "Leda";
  const cj = readJson(join(dir, "characters", who, "character.json"), null);
  const entry = (pj.characters ?? []).find((c) => c.id === who);
  return cj?.voice?.tts_voice || entry?.voice?.tts_voice || entry?.tts_voice || pj.narrator_voice || "Leda";
}

// ความดังต่อเฟรม (0–1) จาก PCM 8 kHz mono — ใช้ขยับปาก
async function rmsPerFrame(file, fps) {
  let stdout;
  try {
    ({ stdout } = await execFileP("ffmpeg", ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", String(RMS_RATE), "-"],
      { encoding: "buffer", maxBuffer: 1 << 26, timeout: PCM_TIMEOUT_MS, killSignal: "SIGKILL" }));
  } catch (err) {
    throw new VfError("INTERNAL", `อ่านเสียง ${basename(file)} ไม่สำเร็จ`, { cause: String(err?.stderr ?? err?.message ?? err).slice(0, 300) });
  }
  const per = RMS_RATE / fps;
  const n = Math.floor(stdout.length / 2);
  const rms = [];
  for (let f = 0; f * per < n; f++) {
    let s = 0;
    let k = 0;
    for (let j = Math.floor(f * per); j < Math.min(n, Math.floor((f + 1) * per)); j++, k++) s += stdout.readInt16LE(j * 2) ** 2;
    rms.push(k ? r3(Math.sqrt(s / k) / 32768) : 0);
  }
  return rms;
}

// ตัวละครทุกตัวใน project ต้องมีท่า (แผนเลือกใช้ตัวไหนก็ได้) — เช็กก่อนจ่ายเงินใดๆ
function requirePoses(dir, slug, characters) {
  const missing = characters.filter((c) => !loadPoses(dir, c.id)?.names.length).map((c) => c.id);
  if (missing.length) {
    throw new VfError("USAGE", `ยังไม่มีท่าของตัวละคร ${missing.join(", ")} รัน ${missing.map((id) => `vf character poses ${slug} ${id}`).join(" และ ")}`, { missing });
  }
}

// แผนอาจถูกทำไว้ก่อนชุดท่าถูกแก้ (vf character poses --replace): เช็กทุกท่าที่แผนใช้ก่อน compose
function requirePlanPoses(dir, slug, plan) {
  const want = {};
  for (const sc of plan.scenes) {
    const cast = new Set(sc.cast.map((c) => c.who));
    for (const c of sc.cast) (want[c.who] ??= new Set()).add(c.pose);
    for (const b of sc.beats ?? []) if (b.pose && cast.has(b.who)) want[b.who].add(b.pose);
  }
  const missing = Object.entries(want).flatMap(([cid, ps]) => {
    const have = new Set(loadPoses(dir, cid)?.names ?? []);
    return [...ps].filter((p) => !have.has(p)).map((p) => ({ cid, pose: p }));
  });
  if (missing.length) {
    const cids = [...new Set(missing.map((m) => m.cid))];
    throw new VfError("USAGE", `แผนนี้ใช้ท่าที่ไม่มีแล้ว: ${missing.map((m) => `${m.cid}/${m.pose}`).join(", ")} รัน ${cids.map((c) => `vf character poses ${slug} ${c}`).join(" และ ")} (หรือใส่ --id ใหม่เพื่อวางแผนใหม่)`, { missing });
  }
}

function dryRun(total, audio, places, warnings) {
  const n = Math.round(total / 5);
  return {
    dry_run: true,
    ...planRows([
      { ...llmRow(5000, 1500), step: "story" },
      { ...llmRow(8000, 5000), step: "scenes" },
      { step: "narration", model: MODELS.tts, count: n * 2, usd: estimate(MODELS.tts, { seconds: total }) },
      qaRow(n + places.length),
      ...(audio.music ? [{ step: "music", model: MODELS.music, count: 1, usd: estimate(MODELS.music, { seconds: Math.max(total + 1, LIBRARY_TRACK_SEC) }), note: "สูงสุด · ถ้า clef เลือกเพลงจากคลังได้ = $0" }] : []),
    ]),
    assumptions: [
      `ประมาณ ${n} ฉาก (ฉากละ ~5 วินาที) · ใช้ท่าตัวละครที่ทำไว้แล้ว ไม่สร้างภาพใหม่ ยกเว้น prop ที่ยังไม่มี (ราว $0.001 ต่อชิ้น)`,
      `พากย์/บทพูดทุกบทรวม ≈ ${total} วินาที${audio.narrator ? " (มีผู้บรรยาย)" : " (ไม่มีผู้บรรยาย ตัวละครพูดเอง)"}`,
      "clef: ตำแหน่งยืนของสถานที่ (ครั้งแรกต่อสถานที่) + ตรวจภาพกลางฉากละ 1 ครั้ง",
      audio.music ? `เพลงจากคลังกลาง (clef เลือก) · ถ้าไม่มีที่เข้ากัน สร้างใหม่ ${Math.max(total + 1, LIBRARY_TRACK_SEC)} วินาทีแล้วเก็บเข้าคลัง` : "ไม่มีเพลง (--no-music)",
      `render ด้วย HyperFrames ในเครื่อง ราว ${Math.ceil((total / 20) * 73 / 60)}–${Math.ceil((total / 20) * 73 / 30)} นาที`,
    ],
    ...(warnings.length ? { warnings } : {}),
  };
}

async function work({ dir, ctx, state, key, prompt, total, audio, places, warnings: early, run: fresh }) {
  const { pj, slug, lang, characters } = ctx;
  const run = pinRun(state, fresh);
  const costDir = join(dir, ".vf");
  const warnings = [...early];
  const narrator = audio.narrator;
  const poses = Object.fromEntries(characters.map((c) => [c.id, loadPoses(dir, c.id).names]));

  const story = await step(state, "story", async () => {
    log("ขั้น story (โครงมุก 5 ช่วง)");
    const user = contextMessage({ dir, characters, places, prompt, notes: [`ความยาวรวม: ${total} วินาที`] });
    const { data } = await llmJson({
      system: storySystemPrompt(lang, total, {
        characters: characters.map((c) => ({ id: c.id, name: c.name, personality: c.personality, poses: poses[c.id] })),
        places: places.map((p) => p.id), props: listProps(dir),
      }),
      user, schema: STORY_SCHEMA, validate: validateStory, maxTokens: 4000,
      meta: { project: slug, step: "motion-story", item: key, run }, costDir,
    });
    return data;
  });

  // prop ใหม่ต้องมีก่อนสร้าง schema ของฉาก (validator ไม่รับ prop ที่ไม่มีจริง)
  await step(state, "props", async () => {
    const have = new Set(listProps(dir).map((p) => p.id));
    const made = [];
    for (const p of story.props_needed) {
      if (have.has(p.id)) continue;
      // checkpoint แยกต่อ prop: cutout พังแล้วรันซ้ำ ไม่สร้างภาพ (จ่ายเงิน) ใหม่
      const sub = { get: (k) => state.get(`props/${p.id}/${k}`), set: (k, v) => state.set(`props/${p.id}/${k}`, v) };
      await makeProp({ dir, slug, id: p.id, desc: p.desc, run, costDir, state: sub });
      have.add(p.id);
      made.push(p.id);
    }
    return { made };
  });

  // ทุกสถานที่ของ project (แผนฉากเลือกได้ทุกที่) — stageFor แคชผลใน place.json จึงถามแค่ครั้งแรก
  const stages = {};
  for (const p of places) {
    // checkpoint ของรันก่อนอาจเป็น stage รุ่นเก่า → อัปเกรดทุกครั้ง
    stages[p.id] = upgradeStage(await step(state, `stage:${p.id}`, async () => {
      log(`ขั้น stage:${p.id}`);
      return stageFor({ dir, place: p.id, meta: { project: slug, step: "stage", item: p.id, run }, costDir });
    }));
  }

  const assets = {
    poses,
    places: Object.fromEntries(places.map((p) => [p.id, Object.keys(stages[p.id].spots)])),
    props: listProps(dir).map((p) => p.id),
    sfx: SFX_KINDS,
  };
  const plan = await step(state, "scenes", async () => {
    log("ขั้น scenes (แผนฉาก)");
    const user = [
      `Request: ${prompt}`,
      `Title: ${story.title}`,
      `Summary: ${story.summary}`,
      "Outline:",
      ...story.beats.map((b) => `- ${b.part}: ${b.text}`),
      `Props in this story: ${story.props_needed.map((p) => p.id).join(", ") || "(none)"}`,
    ].join("\n");
    const { data } = await llmJson({
      system: scenesSystemPrompt(lang, total, assets, { narrator }), user, schema: scenesSchema(assets),
      validate: (p) => validateScenePlan(normalizeScenePlan(p), assets, { total, lang, narrator }), maxTokens: 12000,
      meta: { project: slug, step: "motion-scenes", item: key, run }, costDir,
    });
    return { scenes: normalizeScenePlan(data).scenes };
  });

  const id = `${slugify(story.title).slice(0, 40).replace(/-+$/, "")}-${key.slice(-4)}`;
  const base = `motions/${id}`;
  const rdir = join(dir, base);
  // composition ของ HyperFrames อยู่ใน hf/ แยกจากเสียงและวิดีโอ (lint ไม่เห็นไฟล์เสียงที่ไม่ได้ใช้)
  const hdir = join(rdir, "hf");
  // temp ของ hyperframes อยู่บนดิสก์โปรเจกต์ (นอก hf/ เพื่อไม่ให้ lint/render เห็น)
  const tmpDir = join(rdir, ".tmp");
  mkdirSync(rdir, { recursive: true });
  // characters ระดับบนสุด: เครื่องมือปลายทาง (skill video-gen) อ่านรายชื่อตัวละครจากตรงนี้
  const cast = [...new Set(plan.scenes.flatMap((s) => s.cast.map((c) => c.who)))].sort();
  writeJsonAtomic(join(rdir, "plan.json"), { prompt, total, ...story, characters: cast, ...plan });
  const meta = { project: slug, motion: id, item: id, run };

  const jobs = plan.scenes.flatMap((sc, si) => sc.lines.map((line, li) => ({ key: lineKey(si, li), line })));
  const measured = await pool(jobs, CONCURRENCY, ({ key: k, line }) => step(state, `tts:${k}`, async () => {
    log(`บท ${k}: tts (${line.who})`);
    const raw = join(rdir, `voice-${k}-raw.wav`);
    const file = join(rdir, `voice-${k}.wav`);
    await tts({ text: line.text, voice: voiceOf(dir, pj, line.who), out: raw, meta: { ...meta, item: `${id}#${k}` }, costDir });
    await ffmpeg(["-i", raw, "-af", TRIM, "-ac", "1", "-ar", "48000", file], `ตัดเงียบบท ${k}`);
    rmSync(raw, { force: true });
    const rms = await rmsPerFrame(file, FPS);
    return { seconds: r3(rms.length / FPS), rms };
  }));
  const lines = Object.fromEntries(jobs.map((j, i) => [j.key, measured[i]]));
  // ความยาวทุกอย่าง (คลิป, เสียง, render) มาจาก times เท่านั้น
  const times = sceneTimes(plan, lines);
  const seconds = r3(times.at(-1).start + times.at(-1).dur);
  const cues = audioCues(plan, times);

  await step(state, "compose", async () => {
    log("ขั้น compose (index.html)");
    requirePlanPoses(dir, slug, plan);
    rmSync(hdir, { recursive: true, force: true });
    for (const d of ["assets", "fonts", "vendor"]) mkdirSync(join(hdir, d), { recursive: true });
    const font = fontFile(lang);
    copyFileSync(font, join(hdir, "fonts", basename(font)));
    copyFileSync(gsapFile(), join(hdir, "vendor", "gsap.min.js"));
    const plates = {};
    for (const pid of new Set(plan.scenes.map((s) => s.place))) {
      const src = platePath(dir, pid);
      plates[pid] = `assets/plate-${pid}${extname(src) || ".png"}`;
      copyFileSync(src, join(hdir, plates[pid]));
    }
    for (const cid of new Set(plan.scenes.flatMap((s) => s.cast.map((c) => c.who)))) {
      const ps = loadPoses(dir, cid);
      for (const pose of ps.names) {
        copyFileSync(ps.file(pose), join(hdir, "assets", `${cid}-${pose}.png`));
        copyFileSync(ps.file(pose, true), join(hdir, "assets", `${cid}-${pose}-talk.png`));
      }
    }
    for (const pid of new Set(plan.scenes.flatMap((s) => (s.props ?? []).map((p) => p.id)))) {
      copyFileSync(join(dir, "props", pid, "prop.png"), join(hdir, "assets", `prop-${pid}.png`));
    }
    const html = composeHtml({
      plan, times, lines, stage: stages, size: SIZE, fps: FPS, lang,
      font: { family: FONT_FOR(lang).family, file: basename(font) },
      assets: {
        plate: (pid) => plates[pid],
        sprite: (who, pose, talk) => `assets/${who}-${pose}${talk ? "-talk" : ""}.png`,
        prop: (pid) => `assets/prop-${pid}.png`,
      },
    });
    writeFileSync(join(hdir, "index.html"), html);
    return { file: `${base}/hf/index.html`, seconds };
  });

  const lint = await step(state, "lint", async () => {
    log("ขั้น lint");
    const r = await hfLint(hdir, { tmpDir });
    if (r.errors > 0) {
      // ให้รอบหน้า compose ใหม่จากแผนเดิม (ไม่เรียก LLM/TTS) แทนที่จะ lint HTML เดิมซ้ำ
      state.set("compose", { status: "stale" });
      throw new VfError("INTERNAL", `hyperframes lint พบ ${r.errors} error: ${r.text.slice(0, 1500)}`, { lint: r.text.slice(0, 4000) });
    }
    const codes = [...new Set(r.text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
    return { warnings: r.warnings, codes };
  });
  if (lint.warnings) warnings.push(`hyperframes lint เตือน ${lint.warnings} ข้อ${lint.codes.length ? `: ${lint.codes.join(", ")}` : ""}`);

  const check = await step(state, "check", async () => {
    log("ขั้น check (ภาพกลางฉาก)");
    // โฟลเดอร์ใหม่ทุกครั้ง (hfSnapshot คืน png ทุกไฟล์ในโฟลเดอร์) และอยู่นอกโฟลเดอร์ render
    const snaps = join(dir, ".vf", "motion-check", id);
    rmSync(snaps, { recursive: true, force: true });
    mkdirSync(snaps, { recursive: true });
    const at = times.map((t) => r3(t.start + t.dur / 2));
    const pngs = (await hfSnapshot(hdir, at, snaps, { tmpDir })).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (pngs.length !== at.length) throw new VfError("INTERNAL", `hyperframes snapshot ได้ ${pngs.length} ภาพ (ขอ ${at.length})`);
    const scores = [];
    const found = [];
    for (const [i, png] of pngs.entries()) {
      try {
        const answers = await clef({
          state: STAGING_STATE, questions: { [STAGING_KEY]: { type: "noul", instructions: STAGING_QUESTION } },
          images: [await toQaImage(png)], meta: { ...meta, item: `${id}#${i + 1}` }, costDir,
        });
        const v = Number(answers?.[STAGING_KEY]?.noul);
        scores.push(Number.isFinite(v) ? v : null);
        if (v >= STAGING_WARN) found.push(`ฉาก ${i + 1}: ตัวละครอาจยืนบนเฟอร์นิเจอร์ หลุดขอบภาพ หรือลอยอยู่ (clef ${v.toFixed(2)})`);
      } catch (err) {
        // ขั้นนี้แค่เตือน: ผู้ให้บริการล่มไม่ควรทำให้ทั้งคลิปพัง
        if (!(err instanceof VfError && err.code === "PROVIDER")) throw err;
        scores.push(null);
        found.push(`ฉาก ${i + 1}: ตรวจภาพไม่สำเร็จ (${err.message.slice(0, 120)})`);
      }
    }
    return { scores, warnings: found };
  });
  warnings.push(...check.warnings);

  const video = await step(state, "render", async () => {
    log(`ขั้น render (${seconds} วินาที)`);
    const rel = `${base}/video.mp4`;
    rmSync(join(dir, rel), { force: true });
    // เคลียร์ทุกรอบ ไม่ให้ค้างสะสม; ถ้า render พัง เก็บไว้ดูได้จนรอบหน้า
    rmSync(tmpDir, { recursive: true, force: true });
    const r = await hfRender(hdir, join(dir, rel), { tmpDir });
    rmSync(tmpDir, { recursive: true, force: true });
    let size = 0;
    try { size = statSync(join(dir, rel)).size; } catch {}
    if (!size) throw new VfError("INTERNAL", "hyperframes render ไม่ได้ไฟล์วิดีโอ (ไม่มีไฟล์หรือไฟล์ว่าง)", { file: rel });
    return { file: rel, render_seconds: r.seconds };
  });

  const final = await finishAudio({
    state, dir, base, video: video.file, total: seconds,
    voices: cues.voices.map((v) => ({ file: `${base}/${v.file}`, at: v.at })),
    cues: cues.sfx, musicPrompt: story.music_prompt, story: { title: story.title, summary: story.summary },
    wantMusic: audio.music, sceneAudio: false, meta, out: `renders/${id}.mp4`,
  });

  await step(state, "files", async () => {
    recordEpisode(dir, {
      date: new Date().toISOString().slice(0, 10), mode: "motion", title: story.title, summary: story.summary,
      characters: [...new Set(plan.scenes.flatMap((s) => s.cast.map((c) => c.who)))], file: `renders/${id}.mp4`,
    });
    return { done: true, id };
  });

  return {
    motion: {
      id, title: story.title, seconds, scenes: plan.scenes.length,
      // reused_stills/text คงไว้ให้ผู้เรียกเดิม: แบบใหม่ไม่ใช้ภาพนิ่งจากคลัง และมีคำบรรยายใน HTML เสมอ
      reused_stills: 0, text: true,
      file: join(dir, final.file), dir: rdir, narration: final.narration, music: final.music, sfx: final.sfx,
      ...(final.music_track ? { music_track: final.music_track } : {}),
      ...(warnings.length ? { warnings } : {}),
    },
    cost: { usd: costSince(costDir, run) },
    next: [`vf project show ${slug}`],
  };
}

export async function main(argv) {
  const { values, positionals } = parse(argv, OPTIONS);
  const { prompt, total, id } = parseCommon(values);
  const dir = resolveProject(positionals[0]);
  const ctx = loadProject(dir);
  if (!ctx.characters.length) throw new VfError("USAGE", "project นี้ยังไม่มีตัวละคร");
  if ((ctx.pj.aspect ?? "9:16") !== "9:16") throw new VfError("USAGE", `vf motion ทำได้เฉพาะ project แนวตั้ง 9:16 (project นี้ ${ctx.pj.aspect})`);
  const places = usablePlaces(dir, ctx.places);
  if (!places.length) throw new VfError("USAGE", `project นี้ยังไม่มีสถานที่ที่มีภาพฉาก รัน vf place add ${ctx.slug} --prompt "..."`);
  requirePoses(dir, ctx.slug, ctx.characters);
  const audio = { narrator: Boolean(ctx.pj.narrator) && !values["no-narration"], music: !values["no-music"] };
  const warnings = ignoredWarnings(values);
  if (values["dry-run"]) return dryRun(total, audio, places, warnings);

  const key = id ?? `h${sha(`motion2\0${prompt}\0${total}\0${audio.narrator}\0${audio.music}`).slice(0, 8)}`;
  const stateDir = join(dir, ".vf");
  const openRun = () => {
    // ชื่อ state ใหม่: ไม่ชนกับงานค้างของ motion แบบเก่าที่ใช้ --id เดียวกัน
    const state = openState(stateDir, `motion2-${key}-state.json`);
    if (state.get("files")?.status === "done") {
      throw new VfError("USAGE", `ทำคลิปนี้เสร็จแล้ว: ${state.get("files").output.id} (เปลี่ยน prompt หรือใส่ --id ใหม่เพื่อทำอีกคลิป)`);
    }
    mkdirSync(stateDir, { recursive: true });
    pinInput(state, { prompt_sha: sha(prompt), duration: total, narrator: audio.narrator, music: audio.music },
      ["prompt_sha", "duration", "narrator", "music"],
      "ของ motion ที่ทำค้างไว้ ให้ใช้ input เดิมเพื่อทำต่อ หรือใส่ --id ใหม่เพื่อเริ่มใหม่");
    return state;
  };

  const command = ["motion", dir, `--prompt=${prompt}`, `--duration=${total}`,
    ...(id ? [`--id=${id}`] : []), ...(values["no-narration"] ? ["--no-narration"] : []), ...(values["no-music"] ? ["--no-music"] : []),
    ...(values["no-reuse"] ? ["--no-reuse"] : []), ...(values["max-rerolls"] !== undefined ? [`--max-rerolls=${values["max-rerolls"]}`] : [])];
  return await runEntity({
    dir, projectRef: positionals[0], slug: ctx.slug, command, label: `motion ${key}`, foreground: values.foreground,
    work: ({ run }) => work({ dir, ctx, state: openRun(), key, prompt, total, audio, places, warnings, run }),
  });
}
