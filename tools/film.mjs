// vf film: คลิปยาวหลายช็อต (20–180 วินาที) — LLM เขียนรายการช็อต → keyframe + วิดีโอต่อช็อต (พร้อมกัน 3 ช็อต)
// → ปรับขนาด/เสียงให้เท่ากันแล้วต่อ → รางพากย์ตามเวลา + เพลงเดียวทั้งเรื่อง → mix
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, VfError, log } from "./out.mjs";
import { resolveProject, slugify } from "./paths.mjs";
import { llmJson } from "./llm.mjs";
import { openState, step, writeJsonAtomic, readJson } from "./state.mjs";
import { recordEpisode } from "./bible.mjs";
import { MODELS } from "./models.mjs";
import { estimate } from "./pricing.mjs";
import { sha } from "./project-create.mjs";
import { tts, mediaInfo } from "./audio.mjs";
import { WORDS_PER_SEC, CHARS_PER_SEC } from "./clip.mjs";
import { makeKeyframe, makeVideo, pool } from "./shots.mjs";
import { ffmpeg, frameSize, normalizeArgs, concatArgs, concatList } from "./assemble.mjs";
import { COMMON_OPTIONS, parseCommon, validateParts, finishAudio } from "./longform.mjs";
import { pinInput, pinRun, costSince, contextMessage, loadProject, planRows, llmRow, imageRow, qaRow, runEntity } from "./entities.mjs";

export const SHOT_MIN = 5;
export const SHOT_MAX = 10;
export const CONCURRENCY = 3;
export const VIDEO_BLOCK_RETRIES = 2;
const SOFTEN = "Gentle, family-friendly cartoon tone: playful and harmless, no injury, no peril, no scary moments.";

const OPTIONS = { ...COMMON_OPTIONS, hd: { type: "boolean" } };

export const FILM_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    music_prompt: { type: "string" },
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          duration: { type: "integer" },
          characters: { type: "array", items: { type: "string" } },
          place: { type: "string" },
          first_frame_prompt: { type: "string" },
          video_prompt: { type: "string" },
          narration: { type: "string" },
        },
        required: ["duration", "characters", "place", "first_frame_prompt", "video_prompt", "narration"],
      },
    },
  },
  required: ["title", "summary", "music_prompt", "shots"],
};

export function filmSystemPrompt(lang, total, { narrator = false, musicStyle = "" } = {}) {
  const n = Math.round(total / 7);
  return [
    `คุณคือผู้กำกับหนังสั้น ${total} วินาทีจาก project วิดีโอที่มีอยู่แล้ว เขียนรายการช็อตเป็น JSON ตาม schema เท่านั้น`,
    `- โครงเรื่อง: ช็อตแรกเป็น hook ที่ดึงคนดูใน 3 วินาที แล้วไต่ระดับ มีจุดพลิก และจบด้วย payoff ที่ตลกหรือน่าจดจำ`,
    `- shots: ประมาณ ${n} ช็อต ช็อตละ ${SHOT_MIN}–${SHOT_MAX} วินาที ผลรวม duration ต้องใกล้ ${total} วินาที (คลาดได้ไม่เกิน 10%)`,
    "- แต่ละช็อตมีการกระทำชัดเจนหนึ่งอย่าง ต่อเนื่องจากช็อตก่อนหน้า (ตำแหน่ง ของในมือ สถานที่) เปลี่ยนมุมกล้องระหว่างช็อตให้ดูมีชีวิต",
    "- characters: id ตัวละคร 1–3 ตัวต่อช็อต จาก id ที่มีอยู่เท่านั้น · place: id สถานที่ที่มีอยู่ หรือ \"\"",
    "- first_frame_prompt (ภาษาอังกฤษ): ภาพนิ่งเฟรมแรกของช็อต บอกตำแหน่ง ท่าทาง สีหน้า มุมกล้อง ไม่มีตัวอักษร ป้าย หรือโลโก้",
    "- video_prompt (ภาษาอังกฤษ): เส้นเวลา 2–3 จังหวะต่อ 5 วินาที เช่น \"0-2s: ... 2-5s: ...\" การเคลื่อนกล้อง และเสียงจริงในฉากเท่านั้น (ห้ามดนตรีหรือเสียงประกอบการ์ตูน)",
    "- ห้ามใช้ชื่อคนจริง แบรนด์ หรือตัวละครมีลิขสิทธิ์",
    narrator
      ? `- narration: คำบรรยาย ภาษา ${lang} ของแต่ละช็อต 0–2 ประโยคสั้น เล่าเรื่องต่อเนื่องกันทั้งเรื่อง (ไม่บรรยายภาพตรงๆ) พูดจบในเวลาช็อตลบ 1 วินาที: ไม่เกิน ${WORDS_PER_SEC} คำ/วินาที (ภาษาไม่เว้นวรรค ${CHARS_PER_SEC} ตัวอักษร/วินาที) เว้นว่างบางช็อตได้ให้ภาพเล่าเอง`
      : '- narration: "" ทุกช็อต (project นี้ไม่มีผู้บรรยาย)',
    `- music_prompt (ภาษาอังกฤษ): เพลงประกอบเพลงเดียวทั้งเรื่อง ยึดแนวของ project${musicStyle ? ` (${musicStyle})` : ""} บอกอารมณ์ เครื่องดนตรี BPM และการไต่ระดับ ไม่มีเสียงร้อง`,
    `- title และ summary เป็นภาษา ${lang}`,
  ].join("\n");
}

export const validateFilmPlan = (plan, ctx, { total }) => validateParts(plan, ctx, {
  total, listKey: "shots", minSec: SHOT_MIN, maxSec: SHOT_MAX, textKeys: ["first_frame_prompt", "video_prompt"],
});

function dryRun(total, hd, audio) {
  const quality = hd ? "hd" : "draft";
  const n = Math.round(total / 7);
  return {
    dry_run: true,
    ...planRows([
      llmRow(5000, 2500),
      imageRow("keyframe", n),
      qaRow(n),
      { step: "video", model: MODELS.video, count: n, usd: estimate(MODELS.video, { clips: n, quality }) },
      ...(audio.narrator ? [{ step: "narration", model: MODELS.tts, count: n, usd: estimate(MODELS.tts, { seconds: total }) }] : []),
      ...(audio.music ? [{ step: "music", model: MODELS.music, count: 1, usd: estimate(MODELS.music, { seconds: total + 1 }) }] : []),
    ]),
    assumptions: [
      `ประมาณ ${n} ช็อต (ช็อตละ ~7 วินาที) · keyframe ช็อตละ 1 ภาพ (ไม่มี reroll)`,
      `วิดีโอ ${quality} ${n} คลิป — ราคาวิดีโอยังไม่ยืนยัน (คิดต่อคลิป)`,
      audio.narrator ? `พากย์ทุกช็อตรวม ≈ ${total} วินาที` : "ไม่มีพากย์",
      audio.music ? `เพลงเดียวทั้งเรื่อง ${total + 1} วินาที` : "ไม่มีเพลง (--no-music)",
      `ใช้เวลาราว ${Math.ceil(n / CONCURRENCY) * 2}–${Math.ceil(n / CONCURRENCY) * 4} นาที (ทำพร้อมกัน ${CONCURRENCY} ช็อต)`,
    ],
  };
}

async function work({ dir, ctx, state, key, prompt, total, hd, maxRerolls, audio, run: fresh }) {
  const { pj, slug, lang, characters, places } = ctx;
  const run = pinRun(state, fresh);
  const costDir = join(dir, ".vf");
  const aspect = pj.aspect ?? "9:16";

  const plan = await step(state, "plan", async () => {
    log("ขั้น plan (รายการช็อต)");
    const user = contextMessage({
      dir, characters, places, prompt,
      notes: [
        `ตัวละครที่ใช้ได้: ${characters.map((c) => `${c.id} (${c.name})`).join(", ")}`,
        `สถานที่ที่ใช้ได้: ${places.map((p) => `${p.id} (${p.name})`).join(", ") || "(ไม่มี)"}`,
        `ความยาวรวม: ${total} วินาที`,
      ],
    });
    const { data } = await llmJson({
      system: filmSystemPrompt(lang, total, { narrator: audio.narrator, musicStyle: pj.music_style ?? "" }), user, schema: FILM_SCHEMA,
      validate: (p) => validateFilmPlan(p, ctx, { total }), maxTokens: 12000,
      meta: { project: slug, step: "film-plan", item: key, run }, costDir,
    });
    return {
      ...data,
      shots: data.shots.map((s) => ({ ...s, place: s.place || null, narration: audio.narrator ? s.narration.trim() : "" })),
    };
  });

  const id = `${slugify(plan.title).slice(0, 40).replace(/-+$/, "")}-${key.slice(-4)}`;
  const base = `films/${id}`;
  mkdirSync(join(dir, base), { recursive: true });
  // resume หลังโดนบล็อก: prompt ของช็อตที่แก้ใน plan.json มีผลกับช็อตที่ยังไม่เสร็จ (จำนวนช็อตต้องเท่าเดิม)
  const planFile = join(dir, base, "plan.json");
  const edited = readJson(planFile, null);
  if (edited?.shots?.length === plan.shots.length) {
    plan.shots.forEach((s, i) => {
      for (const k of ["first_frame_prompt", "video_prompt"]) {
        const v = edited.shots[i]?.[k];
        if (typeof v === "string" && v.trim() && v !== s[k]) { s[k] = v.trim(); log(`ช็อต ${i + 1}: ใช้ ${k} ที่แก้ใน plan.json`); }
      }
    });
  }
  writeJsonAtomic(planFile, { prompt, total, ...plan });
  const meta = { project: slug, film: id, item: id, run };
  const { w, h } = frameSize(aspect);
  const warnings = [];

  const shots = await pool(plan.shots, CONCURRENCY, async (shot, i) => {
    const n = String(i + 1).padStart(2, "0");
    const cast = shot.characters.map((cid) => characters.find((c) => c.id === cid));
    const place = shot.place ? places.find((p) => p.id === shot.place) : null;
    const smeta = { ...meta, item: `${id}#${n}` };
    const kf = await step(state, `shot-${n}-keyframe`, async () => {
      log(`ช็อต ${n}: keyframe`);
      return makeKeyframe({
        dir, pj, slug, cast, place, prompt: shot.first_frame_prompt, seedKey: `film:${id}:${n}`, need: `keyframe:${id}#${n}`,
        maxRerolls, meta: smeta, out: `${base}/shot-${n}.jpg`,
      });
    });
    if (kf.warning) warnings.push(`ช็อต ${n}: ${kf.warning}`);
    // ช็อตเดียวโดน moderation ไม่ควรทิ้งทั้งเรื่อง: รอบ 1 ใช้ prompt ที่อ่อนลง, รอบ 2 ทำ keyframe ใหม่ (seed ใหม่) ด้วย
    let vid;
    for (let r = 0; ; r++) {
      const sfx = r ? `-r${r}` : "";
      try {
        const key = r < 2 ? kf : await step(state, `shot-${n}-keyframe${sfx}`, async () => {
          log(`ช็อต ${n}: keyframe ใหม่หลังโดนบล็อก`);
          return makeKeyframe({
            dir, pj, slug, cast, place, prompt: `${shot.first_frame_prompt} ${SOFTEN}`, seedKey: `film:${id}:${n}${sfx}`,
            need: `keyframe:${id}#${n}`, maxRerolls, meta: smeta, out: `${base}/shot-${n}${sfx}.jpg`,
          });
        });
        vid = await step(state, `shot-${n}-video${sfx}`, async () => {
          log(`ช็อต ${n}: video (${hd ? "hd" : "draft"} ${shot.duration} วินาที)${r ? ` ลองใหม่ครั้งที่ ${r}` : ""}`);
          return makeVideo({
            dir, state, requestKey: `shot-${n}-video-request${sfx}`, keyframe: key.file, prompt: r ? `${shot.video_prompt} ${SOFTEN}` : shot.video_prompt,
            duration: shot.duration, hd, aspect, meta: smeta, out: `${base}/shot-${n}.mp4`,
          });
        });
        if (r) warnings.push(`ช็อต ${n}: วิดีโอโดนบล็อก ${r} ครั้ง ทำใหม่ด้วย prompt ที่อ่อนลง${r >= 2 ? " และ keyframe ใหม่" : ""}`);
        break;
      } catch (e) {
        if (!(e instanceof VfError && e.code === "BLOCKED" && r < VIDEO_BLOCK_RETRIES)) throw e;
        log(`ช็อต ${n}: วิดีโอโดนบล็อก (${e.message.slice(0, 120)})`);
      }
    }
    const voice = await step(state, `shot-${n}-narration`, async () => {
      if (!shot.narration) return null;
      log(`ช็อต ${n}: narration`);
      const rel = `${base}/narration-${n}.wav`;
      const info = await tts({ text: shot.narration, voice: pj.narrator_voice || "Leda", out: join(dir, rel), meta: smeta, costDir });
      return { file: rel, seconds: info.duration };
    });
    const norm = await step(state, `shot-${n}-norm`, async () => {
      const info = await mediaInfo(join(dir, vid.file));
      const seconds = Math.min(shot.duration, info.duration || shot.duration);
      const rel = `${base}/norm-${n}.mp4`;
      await ffmpeg(normalizeArgs({ input: join(dir, vid.file), out: join(dir, rel), w, h, hasAudio: info.hasAudio, seconds }), `ปรับช็อต ${n}`);
      return { file: rel, seconds };
    });
    return { n, seconds: norm.seconds, file: norm.file, narration: voice, quality: vid.quality };
  });

  const joined = await step(state, "concat", async () => {
    log("ขั้นต่อช็อต");
    const list = join(dir, base, "shots.txt");
    writeFileSync(list, concatList(shots.map((s) => join(dir, s.file))));
    const rel = `${base}/film-raw.mp4`;
    await ffmpeg(concatArgs({ listFile: list, out: join(dir, rel) }), "ต่อช็อต");
    return { file: rel };
  });

  const final = await finishAudio({
    state, dir, base, video: joined.file, segments: shots, musicPrompt: plan.music_prompt, wantMusic: audio.music,
    sceneAudio: true, meta, out: `renders/${id}.mp4`,
  });

  const quality = shots[0]?.quality ?? (hd ? "hd" : "draft");
  const seconds = Math.round(shots.reduce((s, x) => s + x.seconds, 0) * 10) / 10;
  await step(state, "files", async () => {
    recordEpisode(dir, {
      date: new Date().toISOString().slice(0, 10), mode: `film ${quality}`, title: plan.title, summary: plan.summary,
      characters: [...new Set(plan.shots.flatMap((s) => s.characters))], file: `renders/${id}.mp4`,
    });
    return { done: true, id };
  });

  return {
    film: {
      id, title: plan.title, seconds, shots: shots.length, quality, file: join(dir, final.file), dir: join(dir, base),
      narration: final.narration, music: final.music, ...(warnings.length ? { warnings } : {}),
    },
    cost: { usd: costSince(costDir, run) },
    next: quality === "draft" ? [`vf film ${slug} --prompt "..." --hd  # ทำใหม่แบบ hd เมื่อพอใจ`] : [`vf project show ${slug}`],
  };
}

export async function main(argv) {
  const { values, positionals } = parse(argv, OPTIONS);
  const { prompt, total, id, maxRerolls } = parseCommon(values);
  const hd = Boolean(values.hd);
  const dir = resolveProject(positionals[0]);
  const ctx = loadProject(dir);
  if (!ctx.characters.length) throw new VfError("USAGE", "project นี้ยังไม่มีตัวละคร");
  const audio = { narrator: Boolean(ctx.pj.narrator) && !values["no-narration"], music: !values["no-music"] };
  if (values["dry-run"]) return dryRun(total, hd, audio);

  const key = id ?? `h${sha(`film\0${prompt}\0${total}\0${hd}\0${audio.narrator}\0${audio.music}`).slice(0, 8)}`;
  const stateDir = join(dir, ".vf");
  const openRun = () => {
    const state = openState(stateDir, `film-${key}-state.json`);
    if (state.get("files")?.status === "done") {
      throw new VfError("USAGE", `ทำคลิปนี้เสร็จแล้ว: ${state.get("files").output.id} (เปลี่ยน prompt หรือใส่ --id ใหม่เพื่อทำอีกคลิป)`);
    }
    mkdirSync(stateDir, { recursive: true });
    pinInput(state, { prompt_sha: sha(prompt), duration: total, hd, max_rerolls: maxRerolls, narrator: audio.narrator, music: audio.music },
      ["prompt_sha", "duration", "hd", "max_rerolls", "narrator", "music"],
      "ของ film ที่ทำค้างไว้ ให้ใช้ input เดิมเพื่อทำต่อ หรือใส่ --id ใหม่เพื่อเริ่มใหม่");
    return state;
  };

  const command = ["film", dir, `--prompt=${prompt}`, `--duration=${total}`, `--max-rerolls=${maxRerolls}`,
    ...(hd ? ["--hd"] : []), ...(id ? [`--id=${id}`] : []),
    ...(values["no-narration"] ? ["--no-narration"] : []), ...(values["no-music"] ? ["--no-music"] : [])];
  return await runEntity({
    dir, projectRef: positionals[0], slug: ctx.slug, command, label: `film ${key}`, foreground: values.foreground,
    work: ({ run }) => work({ dir, ctx, state: openRun(), key, prompt, total, hd, maxRerolls, audio, run }),
  });
}
