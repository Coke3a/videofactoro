// vf clip: คลิปสั้นช็อตเดียวจาก prompt (spec §6.2 แบบย่อ: ยังไม่มี end frame, TTS, เพลง, poster)
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, VfError, log } from "./out.mjs";
import { resolveProject, slugify } from "./paths.mjs";
import { llmJson } from "./llm.mjs";
import { openState, step, writeJsonAtomic } from "./state.mjs";
import { riskFindings } from "./risk.mjs";
import { recordEpisode, ID_RE } from "./bible.mjs";
import { clef, toQaImage, qaRecord } from "./qa.mjs";
import { RULES } from "./qa-rules.mjs";
import { MODELS } from "./models.mjs";
import { estimate } from "./pricing.mjs";
import { sha } from "./project-create.mjs";
import { tts, music as makeMusic, mix, mediaInfo, narrationTempo, MUSIC_GAIN, MUSIC_GAIN_UNDER_VOICE } from "./audio.mjs";
import { makeKeyframe, makeVideo, keyframeModel } from "./shots.mjs";
import { pinInput, pinRun, costSince, contextMessage, loadProject, planRows, llmRow, imageRow, qaRow, runEntity } from "./entities.mjs";

const execFileP = promisify(execFile);
const MAX_CHARS = 3;
// music gate (spec §10): ถามพร้อม QA วิดีโอในการเรียก clef ครั้งเดียว
export const NEEDS_MUSIC_MIN = 0.5;
export const DIALOGUE_HEAVY_MIN = 0.6;
const MUSIC_GATE = {
  needs_music: { type: "noul", instructions: "Would this short comedic clip feel better with soft background music added under it?" },
  dialogue_heavy: { type: "noul", instructions: "Is the clip dominated by speech or important sounds that music would cover up?" },
};

const OPTIONS = {
  prompt: { type: "string" },
  duration: { type: "string" },
  hd: { type: "boolean" },
  "no-narration": { type: "boolean" },
  "no-music": { type: "boolean" },
  music: { type: "boolean" },
  id: { type: "string" },
  "max-rerolls": { type: "string" },
  foreground: { type: "boolean" },
  "dry-run": { type: "boolean" },
};

export const CLIP_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    duration: { type: "integer" },
    characters: { type: "array", items: { type: "string" } },
    place: { type: "string" },
    first_frame_prompt: { type: "string" },
    video_prompt: { type: "string" },
    narration: { type: "string" },
    music_prompt: { type: "string" },
  },
  required: ["title", "summary", "duration", "characters", "place", "first_frame_prompt", "video_prompt", "narration", "music_prompt"],
};

// คำบรรยายต้องพูดจบก่อนคลิปจบ: ภาษาที่เว้นวรรคนับคำ (~2.2 คำ/วินาที), ภาษาที่ไม่เว้นวรรค (ไทย ฯลฯ) นับตัวอักษร
export const WORDS_PER_SEC = 2.2;
export const CHARS_PER_SEC = 11;
const SPACED = (lang) => !/^(th|zh|ja|lo|km|my)/i.test(String(lang));
export const narrationBudget = (lang, seconds) => SPACED(lang)
  ? { unit: "คำ", max: Math.floor((seconds - 1) * WORDS_PER_SEC) }
  : { unit: "ตัวอักษร", max: Math.floor((seconds - 1) * CHARS_PER_SEC) };
export const narrationSize = (lang, text) => SPACED(lang) ? text.trim().split(/\s+/).filter(Boolean).length : [...text.replace(/\s+/g, "")].length;

export function clipSystemPrompt(lang, { narrator = false, musicStyle = "" } = {}) {
  return [
    "คุณคือผู้กำกับที่วางแผนคลิปสั้นช็อตเดียวจาก project วิดีโอที่มีอยู่แล้ว ตอบเป็น JSON ตาม schema เท่านั้น",
    `- characters: id ตัวละครที่อยู่ในช็อต 1–${MAX_CHARS} ตัว เลือกจาก id ที่มีอยู่เท่านั้น`,
    '- place: id สถานที่ที่มีอยู่ หรือ "" ถ้าไม่มีที่ไหนเหมาะ',
    "- duration: วินาที 5–20 (ช็อตเดียว เรื่องเล็กๆ ส่วนใหญ่ 5–8)",
    "- first_frame_prompt (ภาษาอังกฤษ): ภาพนิ่งเฟรมแรกของช็อต บอกตำแหน่ง ท่าทาง สีหน้าของแต่ละตัว และฉาก ไม่มี motion blur ห้ามมีตัวอักษร ป้าย หรือโลโก้ในภาพ",
    "- video_prompt (ภาษาอังกฤษ): สิ่งที่เกิดขึ้นในคลิปเป็นเส้นเวลา 2–3 จังหวะต่อ 5 วินาที เช่น \"0-2s: ... 2-5s: ...\" บอกการเคลื่อนไหวของกล้องและเสียงในฉาก ถ้ามีบทพูดให้ใส่ในเครื่องหมายคำพูด",
    "- เสียงใน video_prompt เป็นเสียงจริงในฉากเท่านั้น (เสียงฝีเท้า จาน เห่า ร้อง) ห้ามมีดนตรี เครื่องดนตรี หรือเสียงประกอบแบบการ์ตูน (เช่น strings, xylophone, drum, jingle) เพราะเพลงใส่ทีหลัง",
    "- ห้ามใช้ชื่อคนจริง แบรนด์ หรือตัวละครมีลิขสิทธิ์",
    narrator
      ? `- narration: คำบรรยายของผู้บรรยาย 1–2 ประโยคสั้นๆ ภาษา ${lang} ที่เล่าเรื่องในช็อตนี้ (ไม่อ่านสิ่งที่เห็นซ้ำตรงๆ) ต้องพูดจบในเวลาคลิปลบ 1 วินาที: ไม่เกิน ${WORDS_PER_SEC} คำต่อวินาที (ภาษาที่ไม่เว้นวรรค: ${CHARS_PER_SEC} ตัวอักษรต่อวินาที)`
      : '- narration: "" (project นี้ไม่มีผู้บรรยาย)',
    `- music_prompt (ภาษาอังกฤษ): แนวเพลงประกอบสั้นๆ ของช็อตนี้ ยึดแนวเพลงของ project${musicStyle ? ` (${musicStyle})` : ""} บอกอารมณ์ เครื่องดนตรี และจังหวะ (BPM) ไม่มีเสียงร้อง`,
    `- title และ summary เป็นภาษา ${lang}`,
  ].join("\n");
}

export function validateClipPlan(plan, { characters, places, lang = "en" }, { duration } = {}) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return ["แผนคลิปต้องเป็น object"];
  const issues = [];
  for (const k of ["title", "summary", "first_frame_prompt", "video_prompt"]) {
    if (typeof plan[k] !== "string" || plan[k].trim() === "") issues.push(`${k} ต้องเป็นข้อความที่ไม่ว่าง`);
  }
  if (duration === undefined && !(Number.isInteger(plan.duration) && plan.duration >= 5 && plan.duration <= 20)) {
    issues.push("duration ต้องเป็นจำนวนเต็ม 5–20");
  }
  const ids = new Set(characters.map((c) => c.id));
  const chars = Array.isArray(plan.characters) ? plan.characters : [];
  if (chars.length < 1 || chars.length > MAX_CHARS) issues.push(`characters ต้องมี 1–${MAX_CHARS} ตัว`);
  if (new Set(chars).size !== chars.length) issues.push("characters ซ้ำกัน");
  for (const id of chars) if (!ids.has(id)) issues.push(`ไม่มีตัวละคร id "${id}" ใน project (มี: ${[...ids].join(", ")})`);
  if (plan.place && !places.some((p) => p.id === plan.place)) issues.push(`ไม่มีสถานที่ id "${plan.place}" ใน project`);
  if (typeof plan.narration !== "string") issues.push("narration ต้องเป็นข้อความ (ว่างได้)");
  else if (plan.narration.trim()) {
    const secs = duration ?? plan.duration;
    const { unit, max } = narrationBudget(lang, Number.isFinite(secs) ? secs : 5);
    const n = narrationSize(lang, plan.narration);
    if (n > max) issues.push(`narration ยาวเกินไป (${n} ${unit} > ${max} สำหรับคลิป ${secs} วินาที) ให้สั้นลง`);
  }
  if (typeof plan.music_prompt !== "string" || !plan.music_prompt.trim()) issues.push("music_prompt ต้องเป็นข้อความที่ไม่ว่าง");
  for (const k of ["first_frame_prompt", "video_prompt", "title", "narration"]) {
    for (const f of riskFindings(String(plan[k] ?? ""))) issues.push(`${k} มีคำเสี่ยง: ${f.matched}`);
  }
  return issues;
}

// วิดีโอย่อ 480p ไม่มีเสียง สำหรับ clef (spec §10)
async function toQaVideo(file) {
  const tmp = mkdtempSync(join(tmpdir(), "vf-qav-"));
  try {
    const out = join(tmp, "qa.mp4");
    await execFileP("ffmpeg", ["-loglevel", "error", "-y", "-i", file, "-vf", "scale=-2:480", "-an", "-c:v", "libx264", "-crf", "30", "-preset", "veryfast", out]);
    return "data:video/mp4;base64," + readFileSync(out).toString("base64");
  } catch (err) {
    throw new VfError("INTERNAL", `ย่อวิดีโอสำหรับ QA ไม่สำเร็จ: ${file}`, { cause: String(err?.message ?? err).slice(0, 200) });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function dryRun(duration, hd, audio, pj) {
  const quality = hd ? "hd" : "draft";
  const secs = duration ?? 6;
  return {
    dry_run: true,
    ...planRows([
      llmRow(4000, 600),
      imageRow("keyframe", 1, keyframeModel(pj)),
      qaRow(2),
      { step: "video", model: MODELS.video, count: 1, usd: estimate(MODELS.video, { clips: 1, quality }) },
      ...(audio.narrator ? [{ step: "narration", model: MODELS.tts, count: 1, usd: estimate(MODELS.tts, { seconds: secs }) }] : []),
      ...(audio.music !== false ? [{ step: "music", model: MODELS.music, count: 1, usd: estimate(MODELS.music, { seconds: Math.max(10, secs + 1) }) }] : []),
    ]),
    assumptions: [
      "LLM วางแผน 1 ครั้ง (PROJECT.md + prompt ≈ 4000 tokens เข้า / 600 ออก)",
      "keyframe 1 ภาพ (ไม่มี reroll) · QA keyframe 1 + วิดีโอ 1",
      `วิดีโอ ${quality} 1 คลิป${duration ? ` ${duration} วินาที` : ""} — ราคาวิดีโอยังไม่ยืนยัน (คิดต่อคลิป)`,
      audio.narrator ? `พากย์ (TTS) ≈ ${secs} วินาที` : "ไม่มีพากย์ (project ไม่มีผู้บรรยาย หรือใส่ --no-narration)",
      audio.music === false ? "ไม่มีเพลง (--no-music)" : `เพลง ${Math.max(10, secs + 1)} วินาที${audio.music ? "" : " (ถ้า music gate บอกว่าควรมี)"}`,
    ],
  };
}

async function work({ dir, ctx, state, key, prompt, duration, hd, maxRerolls, audio, run: fresh }) {
  const { pj, slug, lang, characters, places } = ctx;
  const run = pinRun(state, fresh);
  const costDir = join(dir, ".vf");
  const aspect = pj.aspect ?? "9:16";

  const plan = await step(state, "plan", async () => {
    log("ขั้น plan");
    const user = contextMessage({
      dir, characters, places, prompt,
      notes: [
        `ตัวละครที่ใช้ได้: ${characters.map((c) => `${c.id} (${c.name})`).join(", ")}`,
        `สถานที่ที่ใช้ได้: ${places.map((p) => `${p.id} (${p.name})`).join(", ") || "(ไม่มี)"}`,
        ...(duration ? [`ความยาวคลิป: ${duration} วินาที (บังคับ)`] : []),
      ],
    });
    const { data } = await llmJson({
      system: clipSystemPrompt(lang, { narrator: audio.narrator, musicStyle: pj.music_style ?? "" }), user, schema: CLIP_SCHEMA,
      validate: (p) => validateClipPlan(p, ctx, { duration }),
      meta: { project: slug, step: "clip-plan", item: key, run }, costDir,
    });
    return { ...data, place: data.place || null, duration: duration ?? data.duration, narration: audio.narrator ? data.narration.trim() : "" };
  });

  const id = `${slugify(plan.title).slice(0, 40).replace(/-+$/, "")}-${key.slice(-4)}`;
  const clipDir = join(dir, "clips", id);
  mkdirSync(clipDir, { recursive: true });
  writeJsonAtomic(join(clipDir, "plan.json"), { prompt, ...plan });
  const cast = plan.characters.map((cid) => characters.find((c) => c.id === cid));
  const place = plan.place ? places.find((p) => p.id === plan.place) : null;
  const meta = { project: slug, clip: id, item: id, run };

  const key1 = await step(state, "keyframe", async () => {
    log("ขั้น keyframe");
    return makeKeyframe({
      dir, pj, slug, cast, place, prompt: plan.first_frame_prompt, seedKey: `clip:${id}`, need: `keyframe:${id}`,
      maxRerolls, meta, out: `clips/${id}/keyframe.jpg`,
    });
  });

  const video = await step(state, "video", async () => {
    log(`ขั้น video (${hd ? "hd" : "draft"} ${plan.duration} วินาที)`);
    return makeVideo({
      dir, state, requestKey: "video-request", keyframe: key1.file, prompt: plan.video_prompt, duration: plan.duration,
      hd, aspect, meta, out: `clips/${id}/clip.mp4`,
    });
  });

  const vqa = await step(state, "video-qa", async () => {
    log("QA วิดีโอ (รายงานอย่างเดียว)");
    const qctx = { shot: plan.video_prompt };
    try {
      const answers = await clef({
        state: RULES.video.state(qctx), questions: { ...RULES.video.questions(qctx), ...MUSIC_GATE },
        images: [await toQaImage(join(dir, "characters", cast[0].id, "ref", "main.png"))],
        videos: [await toQaVideo(join(dir, video.file))], meta, costDir,
      });
      return qaRecord(RULES.video.judge(answers), answers);
    } catch (e) {
      if (e instanceof VfError && ["PROVIDER", "INTERNAL"].includes(e.code)) return { pass: null, error: e.message };
      throw e;
    }
  });

  const voice = await step(state, "narration", async () => {
    if (!plan.narration) return { file: null };
    log("ขั้น narration (TTS)");
    const rel = `clips/${id}/narration.wav`;
    const info = await tts({ text: plan.narration, voice: pj.narrator_voice || "Leda", out: join(dir, rel), meta, costDir });
    return { file: rel, seconds: info.duration };
  });

  const gate = vqa.answers ?? {};
  const noul = (k) => (typeof gate[k]?.noul === "number" ? gate[k].noul : null);
  const wantMusic = audio.music ?? (noul("needs_music") === null ? true : noul("needs_music") >= NEEDS_MUSIC_MIN);
  const bgm = await step(state, "music", async () => {
    if (!wantMusic) return { file: null };
    log("ขั้น music");
    const rel = `clips/${id}/music.mp3`;
    await makeMusic({ prompt: plan.music_prompt, seconds: plan.duration + 1, out: join(dir, rel), meta, costDir });
    return { file: rel };
  });

  const final = await step(state, "mix", async () => {
    mkdirSync(join(dir, "renders"), { recursive: true });
    const out = join(dir, "renders", `${id}.mp4`);
    if (!voice.file && !bgm.file) {
      copyFileSync(join(dir, video.file), out);
      return { narration: false, music: false };
    }
    log("ขั้น mix");
    const info = await mediaInfo(join(dir, video.file));
    const tempo = voice.file ? narrationTempo(voice.seconds, info.duration) : 1;
    const loud = voice.file || (noul("dialogue_heavy") ?? 0) >= DIALOGUE_HEAVY_MIN;
    await mix({
      video: join(dir, video.file), duration: info.duration, sceneAudio: info.hasAudio,
      narration: voice.file ? join(dir, voice.file) : null, tempo,
      music: bgm.file ? join(dir, bgm.file) : null, musicGain: loud ? MUSIC_GAIN_UNDER_VOICE : MUSIC_GAIN, out,
    });
    const cut = voice.file && voice.seconds / tempo > info.duration - 0.3;
    return { narration: Boolean(voice.file), music: Boolean(bgm.file), tempo, ...(cut ? { warning: "คำบรรยายยาวกว่าคลิป ท้ายประโยคถูกตัด" } : {}) };
  });

  await step(state, "files", async () => {
    log("ขั้น files");
    writeJsonAtomic(join(clipDir, "qa.json"), { keyframe: key1.qa ?? null, video: vqa });
    recordEpisode(dir, {
      date: new Date().toISOString().slice(0, 10), mode: `clip ${video.quality}`, title: plan.title, summary: plan.summary,
      characters: plan.characters, file: `renders/${id}.mp4`,
    });
    return { done: true, id };
  });

  const warnings = [key1.warning, final.warning, vqa.pass === false ? `วิดีโอไม่ผ่าน QA: ${vqa.reasons.join(", ")}` : null,
    vqa.error ? `QA วิดีโอทำไม่สำเร็จ: ${vqa.error}` : null].filter(Boolean);
  return {
    clip: {
      id, title: plan.title, duration: plan.duration, quality: video.quality, characters: plan.characters, place: plan.place,
      file: join(dir, "renders", `${id}.mp4`), raw: join(dir, video.file), keyframe: key1.file,
      narration: plan.narration || null, music: final.music, ...(warnings.length ? { warnings } : {}),
    },
    cost: { usd: costSince(costDir, run) },
    next: video.quality === "draft" ? [`vf clip ${slug} --prompt "..." --hd  # ทำใหม่แบบ hd เมื่อพอใจ`] : [`vf project show ${slug}`],
  };
}

export async function main(argv) {
  const { values, positionals } = parse(argv, OPTIONS);
  const prompt = values.prompt?.trim();
  if (!prompt) throw new VfError("USAGE", 'ต้องระบุ --prompt "..."');
  const duration = values.duration === undefined ? undefined : Number(values.duration);
  if (duration !== undefined && !(Number.isInteger(duration) && duration >= 5 && duration <= 20)) {
    throw new VfError("USAGE", "--duration ต้องเป็นจำนวนเต็ม 5–20");
  }
  const id = values.id;
  if (id !== undefined && !ID_RE.test(id)) throw new VfError("USAGE", "--id ต้องเป็น a-z 0-9 และ - ขึ้นต้นด้วยตัวอักษร ยาว 2–31 ตัว");
  const maxRerolls = values["max-rerolls"] === undefined ? 2 : Number(values["max-rerolls"]);
  if (!Number.isInteger(maxRerolls) || maxRerolls < 0 || maxRerolls > 5) throw new VfError("USAGE", "--max-rerolls ต้องเป็นจำนวนเต็ม 0–5");
  const hd = Boolean(values.hd);
  if (values.music && values["no-music"]) throw new VfError("USAGE", "ใส่ได้อย่างเดียว: --music หรือ --no-music");
  const dir = resolveProject(positionals[0]);
  const ctx = loadProject(dir);
  if (!ctx.characters.length) throw new VfError("USAGE", "project นี้ยังไม่มีตัวละคร");
  const audio = {
    narrator: Boolean(ctx.pj.narrator) && !values["no-narration"],
    music: values.music ? true : values["no-music"] ? false : undefined,
  };
  if (values["dry-run"]) return dryRun(duration, hd, audio, ctx.pj);

  const promptSha = sha(prompt);
  const key = id ?? `h${sha(`${prompt}\0${duration ?? ""}\0${hd}\0${audio.narrator}\0${audio.music ?? "auto"}`).slice(0, 8)}`;
  const stateDir = join(dir, ".vf");
  const openRun = () => {
    const state = openState(stateDir, `clip-${key}-state.json`);
    if (state.get("files")?.status === "done") {
      throw new VfError("USAGE", `ทำคลิปนี้เสร็จแล้ว: ${state.get("files").output.id} (เปลี่ยน prompt หรือใส่ --id ใหม่เพื่อทำอีกคลิป)`);
    }
    mkdirSync(stateDir, { recursive: true });
    pinInput(state, { prompt_sha: promptSha, duration: duration ?? null, hd, max_rerolls: maxRerolls, narrator: audio.narrator, music: audio.music ?? "auto" },
      ["prompt_sha", "duration", "hd", "max_rerolls", "narrator", "music"],
      "ของคลิปที่ทำค้างไว้ ให้ใช้ input เดิมเพื่อทำต่อ หรือใส่ --id ใหม่เพื่อเริ่มคลิปใหม่");
    return state;
  };

  const command = ["clip", dir, `--prompt=${prompt}`, `--max-rerolls=${maxRerolls}`,
    ...(duration ? [`--duration=${duration}`] : []), ...(hd ? ["--hd"] : []), ...(id ? [`--id=${id}`] : []),
    ...(values["no-narration"] ? ["--no-narration"] : []), ...(values.music ? ["--music"] : []), ...(values["no-music"] ? ["--no-music"] : [])];
  return await runEntity({
    dir, projectRef: positionals[0], slug: ctx.slug, command, label: `clip ${key}`, foreground: values.foreground,
    work: ({ run }) => work({ dir, ctx, state: openRun(), key, prompt, duration, hd, maxRerolls, audio, run }),
  });
}
