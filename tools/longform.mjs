// ส่วนร่วมของ vf film และ vf motion: ตรวจ argument, ขอบเขตความยาว, รางพากย์ + เพลง + mix ท้ายงาน
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { VfError, log } from "./out.mjs";
import { step } from "./state.mjs";
import { ID_RE } from "./bible.mjs";
import { riskFindings } from "./risk.mjs";
import { music as makeMusic, mix, mediaInfo, narrationTempo, MUSIC_GAIN, MUSIC_GAIN_UNDER_VOICE } from "./audio.mjs";
import { narrationBudget, narrationSize } from "./clip.mjs";
import { ffmpeg, narrationTrackArgs } from "./assemble.mjs";
import { libraryDir, pickTrack, addTrack, markUsed, LIBRARY_TRACK_SEC } from "./music-lib.mjs";
import { sfxSynthArgs, SFX_GAIN } from "./fx.mjs";

export const MIN_TOTAL = 20;
export const MAX_TOTAL = 180;
export const DEFAULT_TOTAL = 60;
// ผลรวมความยาวช็อตต้องอยู่ในช่วง ±10% ของที่ขอ
export const TOTAL_TOLERANCE = 0.1;

export const COMMON_OPTIONS = {
  prompt: { type: "string" },
  duration: { type: "string" },
  "no-narration": { type: "boolean" },
  "no-music": { type: "boolean" },
  id: { type: "string" },
  "max-rerolls": { type: "string" },
  foreground: { type: "boolean" },
  "dry-run": { type: "boolean" },
};

export function parseCommon(values) {
  const prompt = values.prompt?.trim();
  if (!prompt) throw new VfError("USAGE", 'ต้องระบุ --prompt "..."');
  const total = values.duration === undefined ? DEFAULT_TOTAL : Number(values.duration);
  if (!(Number.isInteger(total) && total >= MIN_TOTAL && total <= MAX_TOTAL)) {
    throw new VfError("USAGE", `--duration ต้องเป็นจำนวนเต็ม ${MIN_TOTAL}–${MAX_TOTAL} (วินาที)`);
  }
  const id = values.id;
  if (id !== undefined && !ID_RE.test(id)) throw new VfError("USAGE", "--id ต้องเป็น a-z 0-9 และ - ขึ้นต้นด้วยตัวอักษร ยาว 2–31 ตัว");
  // klein-4b reroll ราว $0.002: ค่าเริ่มต้น 2 ให้ QA มีโอกาสได้ภาพที่ผ่าน
  const maxRerolls = values["max-rerolls"] === undefined ? 2 : Number(values["max-rerolls"]);
  if (!Number.isInteger(maxRerolls) || maxRerolls < 0 || maxRerolls > 5) throw new VfError("USAGE", "--max-rerolls ต้องเป็นจำนวนเต็ม 0–5");
  return { prompt, total, id, maxRerolls };
}

// ตรวจส่วนที่ film กับ motion มีเหมือนกัน: ชื่อ, เพลง, จำนวนและความยาวช่วง, ตัวละคร/สถานที่, คำบรรยาย, คำเสี่ยง
export function validateParts(plan, { characters, places, lang = "en" }, { total, listKey, minSec, maxSec, textKeys }) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return ["แผนต้องเป็น object"];
  const issues = [];
  for (const k of ["title", "summary", "music_prompt"]) {
    if (typeof plan[k] !== "string" || !plan[k].trim()) issues.push(`${k} ต้องเป็นข้อความที่ไม่ว่าง`);
  }
  const parts = Array.isArray(plan[listKey]) ? plan[listKey] : [];
  const minN = Math.ceil(total / maxSec);
  const maxN = Math.floor(total / minSec);
  if (parts.length < minN || parts.length > maxN) issues.push(`${listKey} ต้องมี ${minN}–${maxN} ช่วง (มี ${parts.length})`);
  const ids = new Set(characters.map((c) => c.id));
  let sum = 0;
  parts.forEach((p, i) => {
    const at = `${listKey}[${i}]`;
    if (p === null || typeof p !== "object") return issues.push(`${at} ต้องเป็น object`);
    if (!(Number.isInteger(p.duration) && p.duration >= minSec && p.duration <= maxSec)) issues.push(`${at}.duration ต้องเป็นจำนวนเต็ม ${minSec}–${maxSec}`);
    else sum += p.duration;
    const chars = Array.isArray(p.characters) ? p.characters : [];
    if (chars.length < 1 || chars.length > 3) issues.push(`${at}.characters ต้องมี 1–3 ตัว`);
    for (const id of chars) if (!ids.has(id)) issues.push(`${at}: ไม่มีตัวละคร id "${id}" (มี: ${[...ids].join(", ")})`);
    if (p.place && !places.some((x) => x.id === p.place)) issues.push(`${at}: ไม่มีสถานที่ id "${p.place}"`);
    for (const k of textKeys) if (typeof p[k] !== "string" || !p[k].trim()) issues.push(`${at}.${k} ต้องเป็นข้อความที่ไม่ว่าง`);
    if (typeof p.narration !== "string") issues.push(`${at}.narration ต้องเป็นข้อความ (ว่างได้)`);
    else if (p.narration.trim() && Number.isInteger(p.duration)) {
      const { unit, max } = narrationBudget(lang, p.duration);
      const n = narrationSize(lang, p.narration);
      if (n > max) issues.push(`${at}.narration ยาวเกินไป (${n} ${unit} > ${max} สำหรับ ${p.duration} วินาที)`);
    }
    for (const k of [...textKeys, "narration"]) {
      for (const f of riskFindings(String(p[k] ?? ""))) issues.push(`${at}.${k} มีคำเสี่ยง: ${f.matched}`);
    }
  });
  const lo = Math.floor(total * (1 - TOTAL_TOLERANCE));
  const hi = Math.ceil(total * (1 + TOTAL_TOLERANCE));
  if (parts.length && (sum < lo || sum > hi)) issues.push(`ผลรวม duration = ${sum} วินาที ต้องอยู่ระหว่าง ${lo}–${hi}`);
  for (const f of riskFindings(String(plan.title ?? ""))) issues.push(`title มีคำเสี่ยง: ${f.matched}`);
  return issues;
}

// segments: [{seconds, narration: {file, seconds} | null}] เรียงตามเวลา (film); video = ไฟล์ที่ต่อแล้ว
// หรือ voices: [{file, at, tempo?}] เวลาเริ่มจริงของแต่ละบท (motion) — ต้องส่ง total มาด้วย
// cues: เสียงประกอบ [{kind, at}] — ว่าง = ไม่มีรางเสียงประกอบ
// story: {title, summary} ให้ clef ใช้เลือกเพลงจากคลังกลาง
export async function finishAudio({ state, dir, base, video, segments, voices, total: fixed, musicPrompt, story = {}, wantMusic, sceneAudio, cues = [], meta, out }) {
  const costDir = join(dir, ".vf");
  if (voices && !(fixed > 0)) throw new VfError("INTERNAL", "finishAudio: voices ต้องมี total");
  const total = fixed ?? segments.reduce((s, x) => s + x.seconds, 0);
  const track = await step(state, "narration-track", async () => {
    let at = 0;
    const items = voices ? voices.map((v) => ({ file: join(dir, v.file), at: v.at, tempo: v.tempo })) : [];
    for (const s of voices ? [] : segments) {
      if (s.narration?.file) items.push({ file: join(dir, s.narration.file), at, tempo: narrationTempo(s.narration.seconds, s.seconds) });
      at += s.seconds;
    }
    if (!items.length) return { file: null };
    log("ขั้นรวมเสียงพากย์");
    const rel = `${base}/narration.wav`;
    await ffmpeg(narrationTrackArgs({ items, duration: total, out: join(dir, rel) }), "รวมเสียงพากย์");
    return { file: rel, sped: items.filter((i) => i.tempo > 1).length };
  });
  const bgm = await step(state, "music", async () => {
    if (!wantMusic) return { file: null };
    log("ขั้น music");
    const rel = `${base}/music.mp3`;
    const need = total + 1;
    const lib = libraryDir(dir);
    const use = { project: basename(dir), title: story.title ?? base };
    const { pick, ranked } = await pickTrack({ lib, need, summary: story.summary ?? "", musicPrompt, meta, costDir });
    if (pick) {
      log(`ใช้เพลงจากคลัง ${pick.track.id} (clef ${pick.score.toFixed(2)})`);
      copyFileSync(join(lib, pick.track.file), join(dir, rel));
      markUsed(lib, pick.track.id, { ...use, score: pick.score });
      return { file: rel, library: pick.track.id, reused: true, score: pick.score, heard: ranked.length };
    }
    // ไม่มีเพลงที่เข้ากัน: สร้างใหม่ให้ยาวพอทั้งคลิปที่ยาวที่สุดที่ทำบ่อย แล้วเก็บเข้าคลัง
    const seconds = Math.max(need, LIBRARY_TRACK_SEC);
    const info = await makeMusic({ prompt: musicPrompt, seconds, out: join(dir, rel), meta, costDir });
    const track = addTrack({ lib, src: join(dir, rel), prompt: musicPrompt, seconds: info?.duration || seconds,
      madeFor: `${use.project} · ${use.title}: ${story.summary ?? ""}`.trim() });
    markUsed(lib, track.id, { ...use, score: null });
    return { file: rel, library: track.id, reused: false, heard: ranked.length };
  });
  const fx = await step(state, "sfx-track", async () => {
    if (!cues.length) return { file: null };
    log("ขั้นเสียงประกอบ");
    const kinds = {};
    for (const kind of new Set(cues.map((c) => c.kind))) {
      kinds[kind] = join(dir, base, `sfx-${kind}.wav`);
      await ffmpeg(sfxSynthArgs(kind, kinds[kind]), `สร้างเสียง ${kind}`);
    }
    const rel = `${base}/sfx.wav`;
    const items = cues.filter((c) => c.at < total).map((c) => ({ file: kinds[c.kind], at: c.at }));
    await ffmpeg(narrationTrackArgs({ items, duration: total, out: join(dir, rel) }), "รวมเสียงประกอบ");
    return { file: rel };
  });
  return await step(state, "mix", async () => {
    mkdirSync(join(dir, "renders"), { recursive: true });
    const dest = join(dir, out);
    if (!track.file && !bgm.file && !fx.file) {
      copyFileSync(join(dir, video), dest);
      return { file: out, narration: false, music: false, sfx: false, ...musicInfo(bgm) };
    }
    log("ขั้น mix");
    const info = await mediaInfo(join(dir, video));
    await mix({
      video: join(dir, video), duration: info.duration, sceneAudio: sceneAudio && info.hasAudio,
      narration: track.file ? join(dir, track.file) : null, tempo: 1,
      music: bgm.file ? join(dir, bgm.file) : null, musicGain: track.file ? MUSIC_GAIN_UNDER_VOICE : MUSIC_GAIN,
      sfx: fx.file ? join(dir, fx.file) : null, sfxGain: SFX_GAIN, out: dest,
    });
    return { file: out, narration: Boolean(track.file), music: Boolean(bgm.file), sfx: Boolean(fx.file), ...musicInfo(bgm), ...(track.sped ? { sped_up_lines: track.sped } : {}) };
  });
}

const musicInfo = (bgm) => (bgm.library ? { music_track: { id: bgm.library, reused: bgm.reused, ...(bgm.reused ? { score: bgm.score } : {}) } } : {});
