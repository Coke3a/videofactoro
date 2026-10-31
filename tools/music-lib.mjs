// คลังเพลงกลาง (ใช้ร่วมทุก project): clef-omni ฟังเพลงในคลังแล้วตัดสินว่าเข้ากับคลิปไหม ไม่มีเพลงที่เข้ากัน = สร้างใหม่แล้วเก็บเข้าคลัง
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readJson, writeJsonAtomic } from "./state.mjs";
import { slugify } from "./paths.mjs";
import { clef } from "./qa.mjs";
import { mediaInfo } from "./audio.mjs";
import { VfError, log } from "./out.mjs";

const execFileP = promisify(execFile);

// เพลงใหม่ยาวเท่าคลิปที่ยาวที่สุดที่ทำบ่อย (90 วินาที) จะได้ใช้ซ้ำกับคลิปไหนก็ได้โดยไม่ต้องวน
export const LIBRARY_TRACK_SEC = 90;
// spike 2026-10-28: เพลงที่เข้ากัน ~0.79 · ไม่เข้ากัน ~0.05
export const MUSIC_FIT_MIN = 0.6;
// clef ฟังทีละเพลง: จำกัดจำนวนที่ฟังต่อคลิป เลือกเพลงที่ถูกใช้น้อยก่อน
export const MAX_CANDIDATES = 8;
// คลังเต็ม (เพลงที่ยาวพอมีครบเท่านี้): ไม่สร้างเพลงใหม่อีก ใช้เพลงคะแนนสูงสุดแม้ไม่ถึง MUSIC_FIT_MIN (Coke 2026-10-31 ประหยัดค่าเพลง)
export const LIBRARY_FULL = 8;
// ...ยกเว้นเพลงที่ไม่เข้ากันเลย (spike ~0.05) ยังสร้างใหม่
export const MUSIC_FIT_FLOOR = 0.3;
const EXCERPT_SEC = 20;

export const libraryDir = (projectDir) => process.env.VF_MUSIC_LIBRARY || join(dirname(projectDir), "_music");
const indexFile = (lib) => join(lib, "index.json");

export function loadLibrary(lib) {
  const idx = readJson(indexFile(lib), { tracks: [] });
  return Array.isArray(idx.tracks) ? idx : { tracks: [] };
}

function saveLibrary(lib, idx) {
  mkdirSync(lib, { recursive: true });
  writeJsonAtomic(indexFile(lib), idx);
  writeFileSync(join(lib, "MUSIC.md"), renderMusicMd(idx));
}

export function renderMusicMd(idx) {
  const lines = [
    "# คลังเพลงกลาง",
    "",
    "เพลงประกอบที่ใช้ร่วมกันทุก project · vf เขียนไฟล์นี้ใหม่ทุกครั้งที่คลังเปลี่ยน (อย่าแก้ด้วยมือ ให้แก้ index.json)",
    `ตอนทำคลิป clef-omni ฟังเพลงที่ยาวพอทีละเพลง ถ้าคะแนนเข้ากับเรื่องถึง ${MUSIC_FIT_MIN} ใช้ซ้ำ ไม่ถึง = สร้างเพลงใหม่ ${LIBRARY_TRACK_SEC} วินาทีแล้วเก็บเข้าคลัง`,
    `คลังเต็มเมื่อมีเพลงที่ยาวพอครบ ${LIBRARY_FULL} เพลง: ไม่สร้างใหม่อีก ใช้เพลงคะแนนสูงสุด เว้นแต่ทุกเพลงได้ต่ำกว่า ${MUSIC_FIT_FLOOR}`,
    "",
  ];
  for (const t of idx.tracks) {
    lines.push(`## ${t.id}`, "",
      `- ไฟล์: \`${t.file}\` · ยาว ${Math.round(t.seconds)} วินาที (ใช้กับคลิปที่ยาวไม่เกินนี้)`,
      `- แนว/อารมณ์/เครื่องดนตรี/BPM: ${t.prompt}`,
      `- สร้างครั้งแรกสำหรับ: ${t.made_for || "-"}`,
      `- ใช้แล้ว ${t.uses?.length ?? 0} ครั้ง${t.uses?.length ? ":" : ""}`);
    for (const u of (t.uses ?? []).slice(-10)) lines.push(`  - ${u.at.slice(0, 10)} ${u.project} · ${u.title}${u.score != null ? ` (clef ${u.score.toFixed(2)})` : " (สร้างใหม่)"}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ตัดท่อนกลางเพลงสั้นๆ แบบ mono ให้ clef ฟัง (ประหยัด token)
async function excerpt(file) {
  const dur = (await mediaInfo(file)).duration;
  const start = Math.max(0, Math.min(8, dur - EXCERPT_SEC));
  const { stdout } = await execFileP("ffmpeg", ["-loglevel", "error", "-ss", String(start), "-t", String(EXCERPT_SEC), "-i", file,
    "-ac", "1", "-b:a", "64k", "-f", "mp3", "pipe:1"], { encoding: "buffer", maxBuffer: 1 << 24 });
  if (!stdout.length) throw new VfError("INTERNAL", `ตัดท่อนเพลงไม่ได้: ${file}`);
  return "data:audio/mpeg;base64," + stdout.toString("base64");
}

const q = (instructions) => ({ type: "noul", instructions });
const num = (a, k) => (typeof a?.[k]?.noul === "number" && Number.isFinite(a[k].noul) ? a[k].noul : 0);

// เพลงที่ยาวพอ เรียงจากใช้น้อย → ใช้มาก แล้วให้ clef ฟังทีละเพลง · คืนเพลงคะแนนสูงสุดที่ผ่านเกณฑ์ หรือ null
export async function pickTrack({ lib, need, summary, musicPrompt, meta, costDir }) {
  const idx = loadLibrary(lib);
  const long = idx.tracks.filter((t) => t.seconds >= need && existsSync(join(lib, t.file)));
  const full = long.length >= LIBRARY_FULL;
  const pool = long
    .sort((a, b) => (a.uses?.length ?? 0) - (b.uses?.length ?? 0) || String(b.created).localeCompare(String(a.created)))
    .slice(0, MAX_CANDIDATES);
  const ranked = [];
  for (const t of pool) {
    log(`clef ฟังเพลง ${t.id}`);
    try {
      const answers = await clef({
        state: `Background music candidate for a short cartoon video (${Math.round(need)} seconds). Story: ${summary}. Wanted music: ${musicPrompt}`,
        questions: {
          fits_story: q("Does this music fit as background music for this story?"),
          fits_mood: q("Do the mood, energy and tempo of this music match the wanted music?"),
        },
        audio: [await excerpt(join(lib, t.file))],
        meta: { ...meta, step: "music-pick" },
        costDir,
      });
      ranked.push({ track: t, score: Math.min(num(answers, "fits_story"), num(answers, "fits_mood")) });
    } catch (err) {
      if (!(err instanceof VfError) || !["PROVIDER", "INTERNAL"].includes(err.code)) throw err;
      log(`ฟังเพลง ${t.id} ไม่สำเร็จ (${err.code}) ข้าม`);
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const min = full ? MUSIC_FIT_FLOOR : MUSIC_FIT_MIN;
  return { pick: best && best.score >= min ? best : null, full, ranked: ranked.map((r) => ({ id: r.track.id, score: r.score })) };
}

export function addTrack({ lib, src, prompt, seconds, madeFor, source = "generated" }) {
  const idx = loadLibrary(lib);
  const hash = createHash("sha256").update(`${prompt}\0${Date.now()}\0${idx.tracks.length}`).digest("hex").slice(0, 4);
  const id = `${slugify(prompt.split(/[,.]/)[0]).slice(0, 40) || "track"}-${hash}`;
  const file = `${id}.mp3`;
  mkdirSync(lib, { recursive: true });
  copyFileSync(src, join(lib, file));
  const track = { id, file, seconds, prompt, made_for: madeFor, source, created: new Date().toISOString(), uses: [] };
  idx.tracks.push(track);
  saveLibrary(lib, idx);
  return track;
}

export function markUsed(lib, id, use) {
  const idx = loadLibrary(lib);
  const t = idx.tracks.find((x) => x.id === id);
  if (!t) return;
  t.uses = [...(t.uses ?? []), { at: new Date().toISOString(), ...use }];
  saveLibrary(lib, idx);
}
