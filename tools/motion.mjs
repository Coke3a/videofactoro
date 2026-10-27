// vf motion: คลิป motion-comic (20–180 วินาที) จากภาพนิ่ง AI ของตัวละครใน project — ไม่ใช้โมเดลวิดีโอ
// LLM เขียนฉาก → ภาพนิ่งต่อฉาก (ref ตัวละคร + QA) → ffmpeg ขยับภาพ (กล้อง ease + จังหวะพีก punch-in/แฟลช) → ต่อ
// → ตัวหนังสือ ASS (ชื่อเรื่อง, การ์ดอันดับ, คำบรรยายใต้ภาพ, คำเสียง) → พากย์ + เพลง + เสียงประกอบ → mix
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, VfError, log } from "./out.mjs";
import { resolveProject, slugify } from "./paths.mjs";
import { llmJson } from "./llm.mjs";
import { openState, step, writeJsonAtomic } from "./state.mjs";
import { recordEpisode } from "./bible.mjs";
import { MODELS } from "./models.mjs";
import { estimate } from "./pricing.mjs";
import { sha } from "./project-create.mjs";
import { tts, MUSIC_LOOP_SEC } from "./audio.mjs";
import { WORDS_PER_SEC, CHARS_PER_SEC } from "./clip.mjs";
import { makeKeyframe, pool, keyframeModel, reuseStill } from "./shots.mjs";
import { ffmpeg, frameSize, stillMotionArgs, concatArgs, concatList, hasFilter, writeAss, burnArgs, fontFor, MOVES } from "./assemble.mjs";
import { motionCues, HIT_AT } from "./fx.mjs";
import { COMMON_OPTIONS, parseCommon, validateParts, finishAudio } from "./longform.mjs";
import { pinInput, pinRun, costSince, contextMessage, loadProject, planRows, llmRow, imageRow, qaRow, runEntity } from "./entities.mjs";

export const SCENE_MIN = 3;
export const SCENE_MAX = 8;
export const CONCURRENCY = 3;

const OPTIONS = { ...COMMON_OPTIONS, "no-reuse": { type: "boolean" } };
const CAPTION_MAX = 60;
const TAG_MAX = 14;

export const MOTION_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    music_prompt: { type: "string" },
    scenes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          duration: { type: "integer" },
          characters: { type: "array", items: { type: "string" } },
          place: { type: "string" },
          image_prompt: { type: "string" },
          move: { type: "string", enum: MOVES },
          card: { type: "string" },
          caption: { type: "string" },
          sfx_word: { type: "string" },
          narration: { type: "string" },
        },
        required: ["duration", "characters", "place", "image_prompt", "move", "card", "caption", "sfx_word", "narration"],
      },
    },
  },
  required: ["title", "summary", "music_prompt", "scenes"],
};

export function motionSystemPrompt(lang, total, { narrator = false, musicStyle = "" } = {}) {
  const n = Math.round(total / 5);
  return [
    `คุณคือผู้กำกับคลิป motion-comic ${total} วินาทีจาก project วิดีโอที่มีอยู่แล้ว (ภาพนิ่ง AI ที่ขยับด้วยกล้อง + ตัวหนังสือ + พากย์ + เพลง) ตอบเป็น JSON ตาม schema เท่านั้น`,
    "- เลือก format ที่เหมาะกับคำขอ เช่น นับถอยหลังอันดับ (Top 5 ...), เรื่องเล่าสั้นมีหักมุม, before/after; ฉากแรกเป็น hook ภายใน 3 วินาที ฉากสุดท้ายเป็น payoff",
    `- scenes: ประมาณ ${n} ฉาก ฉากละ ${SCENE_MIN}–${SCENE_MAX} วินาที ผลรวม duration ต้องใกล้ ${total} วินาที (คลาดได้ไม่เกิน 10%) จังหวะเร็ว ตัดบ่อย`,
    "- characters: id ตัวละคร 1–3 ตัวต่อฉาก จาก id ที่มีอยู่เท่านั้น · place: id สถานที่ที่มีอยู่ หรือ \"\"",
    "- image_prompt (ภาษาอังกฤษ): ภาพนิ่งของฉาก ท่าทางและสีหน้าที่ชัดและเกินจริงแบบการ์ตูน จับจังหวะพีกของมุก มุมกล้องหลากหลาย ห้ามมีตัวอักษร ป้าย หรือโลโก้ในภาพ",
    `- move: การขยับกล้อง หนึ่งใน ${MOVES.join(", ")} (shake = ตอนชน/ตกใจ, bounce = ตอนดีใจ/เต้น, zoom_in = เน้นสีหน้า, pan = เผยของในฉาก, tilt_up = เผยของสูงหรือตัวละครยืนตระหง่าน, crash_zoom = พุ่งเข้าหาตอนเปิดเผย/หักมุม) อย่าใช้ซ้ำติดกันเกิน 2 ฉาก`,
    `- card: ป้ายใหญ่ตอนเริ่มฉาก เช่น "#5" หรือ "ROUND 2" ไม่เกิน ${TAG_MAX} ตัวอักษร หรือ "" ถ้าไม่ต้องการ`,
    `- caption: ข้อความใต้ภาพสั้นๆ ภาษา ${lang} ไม่เกิน ${CAPTION_MAX} ตัวอักษร ตลกหรือเล่าเรื่อง (ไม่ซ้ำกับ narration คำต่อคำ)`,
    `- sfx_word: คำเสียงแบบการ์ตูนตอนพีก เช่น "BONK!", "CRASH!", "NOPE!" ไม่เกิน ${TAG_MAX} ตัวอักษร หรือ "" — ใส่แล้วฉากนั้นจะมีแฟลช กล้องกระแทก และเสียงตอนพีก จึงใส่เฉพาะฉากที่มีจังหวะมุกจริง ไม่ใช่ทุกฉาก`,
    "- ห้ามใช้ชื่อคนจริง แบรนด์ หรือตัวละครมีลิขสิทธิ์",
    narrator
      ? `- narration: คำพากย์ ภาษา ${lang} ของแต่ละฉาก 0–2 ประโยคสั้น เล่าต่อเนื่องและมีจังหวะมุก พูดจบในเวลาฉากลบ 1 วินาที: ไม่เกิน ${WORDS_PER_SEC} คำ/วินาที (ภาษาไม่เว้นวรรค ${CHARS_PER_SEC} ตัวอักษร/วินาที)`
      : '- narration: "" ทุกฉาก (project นี้ไม่มีผู้บรรยาย)',
    `- music_prompt (ภาษาอังกฤษ): เพลงเดียวทั้งคลิป สนุก มีพลัง ยึดแนวของ project${musicStyle ? ` (${musicStyle})` : ""} บอกเครื่องดนตรีและ BPM ไม่มีเสียงร้อง`,
    `- title (สั้น ใช้เป็นตัวหนังสือเปิดคลิป) และ summary เป็นภาษา ${lang}`,
  ].join("\n");
}

export function validateMotionPlan(plan, ctx, { total }) {
  const issues = validateParts(plan, ctx, {
    total, listKey: "scenes", minSec: SCENE_MIN, maxSec: SCENE_MAX, textKeys: ["image_prompt", "caption"],
  });
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  scenes.forEach((s, i) => {
    if (s === null || typeof s !== "object") return;
    if (!MOVES.includes(s.move)) issues.push(`scenes[${i}].move ต้องเป็นหนึ่งใน ${MOVES.join(", ")}`);
    if (typeof s.caption === "string" && [...s.caption].length > CAPTION_MAX) issues.push(`scenes[${i}].caption ยาวเกิน ${CAPTION_MAX} ตัวอักษร`);
    for (const k of ["card", "sfx_word"]) {
      if (typeof s[k] !== "string") issues.push(`scenes[${i}].${k} ต้องเป็นข้อความ (ว่างได้)`);
      else if ([...s[k]].length > TAG_MAX) issues.push(`scenes[${i}].${k} ยาวเกิน ${TAG_MAX} ตัวอักษร`);
    }
  });
  return issues;
}

// ตัวหนังสือทั้งคลิปตามเวลาของแต่ละฉาก
export function motionEvents(title, scenes) {
  const events = [];
  let at = 0;
  scenes.forEach((s, i) => {
    const end = at + s.seconds;
    if (i === 0 && title) events.push({ start: 0, end: Math.min(2.5, end - 0.1), text: title, style: "Title" });
    if (s.card) events.push({ start: at, end: Math.min(at + 1.3, end), text: s.card, style: "Card" });
    if (s.caption) events.push({ start: at + 0.2, end: end - 0.1, text: s.caption, style: "Caption" });
    if (s.sfx_word) {
      const t = at + s.seconds * HIT_AT;
      events.push({ start: t, end: Math.min(t + 0.9, end), text: s.sfx_word, style: "Sfx" });
    }
    at = end;
  });
  return events;
}

function dryRun(total, audio, pj) {
  const n = Math.round(total / 5);
  return {
    dry_run: true,
    ...planRows([
      llmRow(5000, 3000),
      imageRow("still", n, keyframeModel(pj)),
      qaRow(n),
      ...(audio.narrator ? [{ step: "narration", model: MODELS.tts, count: n, usd: estimate(MODELS.tts, { seconds: total }) }] : []),
      ...(audio.music ? [{ step: "music", model: MODELS.music, count: 1, usd: estimate(MODELS.music, { seconds: Math.min(total + 1, MUSIC_LOOP_SEC) }) }] : []),
    ]),
    assumptions: [
      `ประมาณ ${n} ฉาก (ฉากละ ~5 วินาที) · ภาพนิ่งฉากละ 1 ภาพ (ไม่มี reroll) · ไม่ใช้โมเดลวิดีโอ`,
      audio.narrator ? `พากย์ทุกฉากรวม ≈ ${total} วินาที` : "ไม่มีพากย์",
      audio.music ? total + 1 > MUSIC_LOOP_SEC ? `เพลงท่อนเดียว ${MUSIC_LOOP_SEC} วินาที วนให้ยาวทั้งคลิป` : `เพลงเดียวทั้งคลิป ${total + 1} วินาที` : "ไม่มีเพลง (--no-music)",
      hasFilter("ass") ? "ตัวหนังสือ: ffmpeg มี libass" : "คำเตือน: ffmpeg เครื่องนี้ไม่มี libass จะไม่มีตัวหนังสือในคลิป",
      `render ด้วย ffmpeg ในเครื่องราว ${Math.ceil(total / 20)}–${Math.ceil(total / 8)} นาที`,
    ],
  };
}

async function work({ dir, ctx, state, key, prompt, total, maxRerolls, audio, reuse, run: fresh }) {
  const { pj, slug, lang, characters, places } = ctx;
  const run = pinRun(state, fresh);
  const costDir = join(dir, ".vf");
  const aspect = pj.aspect ?? "9:16";

  const plan = await step(state, "plan", async () => {
    log("ขั้น plan (รายการฉาก)");
    const user = contextMessage({
      dir, characters, places, prompt,
      notes: [
        `ตัวละครที่ใช้ได้: ${characters.map((c) => `${c.id} (${c.name})`).join(", ")}`,
        `สถานที่ที่ใช้ได้: ${places.map((p) => `${p.id} (${p.name})`).join(", ") || "(ไม่มี)"}`,
        `ความยาวรวม: ${total} วินาที`,
      ],
    });
    const { data } = await llmJson({
      system: motionSystemPrompt(lang, total, { narrator: audio.narrator, musicStyle: pj.music_style ?? "" }), user, schema: MOTION_SCHEMA,
      validate: (p) => validateMotionPlan(p, ctx, { total }), maxTokens: 12000,
      meta: { project: slug, step: "motion-plan", item: key, run }, costDir,
    });
    return {
      ...data,
      scenes: data.scenes.map((s) => ({ ...s, place: s.place || null, narration: audio.narrator ? s.narration.trim() : "" })),
    };
  });

  const id = `${slugify(plan.title).slice(0, 40).replace(/-+$/, "")}-${key.slice(-4)}`;
  const base = `motions/${id}`;
  mkdirSync(join(dir, base), { recursive: true });
  writeJsonAtomic(join(dir, base, "plan.json"), { prompt, total, ...plan });
  const meta = { project: slug, motion: id, item: id, run };
  const { w, h } = frameSize(aspect);
  const warnings = [];
  const reserved = new Set();

  const made = await pool(plan.scenes, CONCURRENCY, async (scene, i) => {
    const n = String(i + 1).padStart(2, "0");
    const cast = scene.characters.map((cid) => characters.find((c) => c.id === cid));
    const place = scene.place ? places.find((p) => p.id === scene.place) : null;
    const smeta = { ...meta, item: `${id}#${n}` };
    const still = await step(state, `scene-${n}-still`, async () => {
      if (reuse) {
        const old = await reuseStill({ dir, pj, cast, place, prompt: scene.image_prompt, use: `${id}#${n}`, reserved, skipNeed: `still:${id}#`, meta: smeta, out: `${base}/scene-${n}.jpg` });
        if (old) {
          log(`ฉาก ${n}: ใช้ภาพเก่า ${old.reused}`);
          return old;
        }
      }
      log(`ฉาก ${n}: ภาพนิ่ง`);
      return makeKeyframe({
        dir, pj, slug, cast, place, prompt: scene.image_prompt, seedKey: `motion:${id}:${n}`, need: `still:${id}#${n}`,
        kind: "still", maxRerolls, meta: smeta, out: `${base}/scene-${n}.jpg`,
      });
    });
    if (still.warning) warnings.push(`ฉาก ${n}: ${still.warning}`);
    const voice = await step(state, `scene-${n}-narration`, async () => {
      if (!scene.narration) return null;
      log(`ฉาก ${n}: narration`);
      const rel = `${base}/narration-${n}.wav`;
      const info = await tts({ text: scene.narration, voice: pj.narrator_voice || "Leda", out: join(dir, rel), meta: smeta, costDir });
      return { file: rel, seconds: info.duration };
    });
    return { n, still, voice };
  });

  // ffmpeg ทีละฉาก (sandbox มี CPU น้อย)
  const scenes = [];
  for (const [i, scene] of plan.scenes.entries()) {
    const { n, still, voice } = made[i];
    const clip = await step(state, `scene-${n}-render`, async () => {
      log(`ฉาก ${n}: render (${scene.move} ${scene.duration} วินาที)`);
      const rel = `${base}/scene-${n}.mp4`;
      const hit = scene.sfx_word ? scene.duration * HIT_AT : null;
      await ffmpeg(stillMotionArgs({ image: join(dir, still.file), out: join(dir, rel), w, h, seconds: scene.duration, move: scene.move, hit, first: i === 0 }), `ฉาก ${n}`);
      return { file: rel };
    });
    scenes.push({ ...scene, n, seconds: scene.duration, file: clip.file, narration: voice });
  }

  const joined = await step(state, "concat", async () => {
    log("ขั้นต่อฉาก");
    const list = join(dir, base, "scenes.txt");
    writeFileSync(list, concatList(scenes.map((s) => join(dir, s.file))));
    const rel = `${base}/motion-raw.mp4`;
    await ffmpeg(concatArgs({ listFile: list, out: join(dir, rel) }), "ต่อฉาก");
    return { file: rel };
  });

  const texted = await step(state, "text", async () => {
    if (!hasFilter("ass")) return { file: joined.file, text: false };
    log("ขั้นตัวหนังสือ");
    const ass = writeAss(join(dir, base, "text.ass"), { w, h, font: fontFor(lang), events: motionEvents(plan.title, scenes) });
    const rel = `${base}/motion-text.mp4`;
    await ffmpeg(burnArgs({ input: join(dir, joined.file), assFile: ass, out: join(dir, rel) }), "ใส่ตัวหนังสือ");
    return { file: rel, text: true };
  });
  if (!texted.text) warnings.push("ffmpeg เครื่องนี้ไม่มี libass จึงไม่มีตัวหนังสือในคลิป (ติดตั้ง ffmpeg ที่มี libass แล้วรันใหม่ด้วย --id ใหม่)");

  const final = await finishAudio({
    state, dir, base, video: texted.file, segments: scenes, musicPrompt: plan.music_prompt, wantMusic: audio.music,
    sceneAudio: false, cues: motionCues(scenes), meta, out: `renders/${id}.mp4`,
  });

  await step(state, "files", async () => {
    recordEpisode(dir, {
      date: new Date().toISOString().slice(0, 10), mode: "motion", title: plan.title, summary: plan.summary,
      characters: [...new Set(plan.scenes.flatMap((s) => s.characters))], file: `renders/${id}.mp4`,
    });
    return { done: true, id };
  });

  return {
    motion: {
      id, title: plan.title, seconds: scenes.reduce((s, x) => s + x.seconds, 0), scenes: scenes.length,
      reused_stills: made.filter((m) => m.still.reused).length,
      file: join(dir, final.file), dir: join(dir, base), text: texted.text, narration: final.narration, music: final.music, sfx: final.sfx,
      ...(warnings.length ? { warnings } : {}),
    },
    cost: { usd: costSince(costDir, run) },
    next: [`vf project show ${slug}`],
  };
}

export async function main(argv) {
  const { values, positionals } = parse(argv, OPTIONS);
  const { prompt, total, id, maxRerolls } = parseCommon(values);
  const dir = resolveProject(positionals[0]);
  const ctx = loadProject(dir);
  if (!ctx.characters.length) throw new VfError("USAGE", "project นี้ยังไม่มีตัวละคร");
  const audio = { narrator: Boolean(ctx.pj.narrator) && !values["no-narration"], music: !values["no-music"] };
  if (values["dry-run"]) return dryRun(total, audio, ctx.pj);

  const key = id ?? `h${sha(`motion\0${prompt}\0${total}\0${audio.narrator}\0${audio.music}`).slice(0, 8)}`;
  const stateDir = join(dir, ".vf");
  const openRun = () => {
    const state = openState(stateDir, `motion-${key}-state.json`);
    if (state.get("files")?.status === "done") {
      throw new VfError("USAGE", `ทำคลิปนี้เสร็จแล้ว: ${state.get("files").output.id} (เปลี่ยน prompt หรือใส่ --id ใหม่เพื่อทำอีกคลิป)`);
    }
    mkdirSync(stateDir, { recursive: true });
    pinInput(state, { prompt_sha: sha(prompt), duration: total, max_rerolls: maxRerolls, narrator: audio.narrator, music: audio.music },
      ["prompt_sha", "duration", "max_rerolls", "narrator", "music"],
      "ของ motion ที่ทำค้างไว้ ให้ใช้ input เดิมเพื่อทำต่อ หรือใส่ --id ใหม่เพื่อเริ่มใหม่");
    return state;
  };

  const reuse = !values["no-reuse"];
  const command = ["motion", dir, `--prompt=${prompt}`, `--duration=${total}`, `--max-rerolls=${maxRerolls}`,
    ...(id ? [`--id=${id}`] : []), ...(values["no-narration"] ? ["--no-narration"] : []), ...(values["no-music"] ? ["--no-music"] : []), ...(reuse ? [] : ["--no-reuse"])];
  return await runEntity({
    dir, projectRef: positionals[0], slug: ctx.slug, command, label: `motion ${key}`, foreground: values.foreground,
    work: ({ run }) => work({ dir, ctx, state: openRun(), key, prompt, total, maxRerolls, audio, reuse, run }),
  });
}
