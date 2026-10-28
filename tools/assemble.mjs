// ประกอบวิดีโอหลายช็อตด้วย ffmpeg: ปรับทุกช็อตให้ขนาด/fps/เสียงเท่ากัน, ต่อกัน, รางเสียงพากย์ตามเวลา, วนเพลง
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { VfError } from "./out.mjs";

const execFileP = promisify(execFile);

export const FPS = 24;

export function frameSize(aspect) {
  if (aspect === "16:9") return { w: 1280, h: 720 };
  if (aspect === "1:1") return { w: 960, h: 960 };
  return { w: 720, h: 1280 };
}

// ffmpeg ที่ค้างไม่สนใจ SIGTERM → หมดเวลาแล้วฆ่าด้วย SIGKILL
export const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

export async function ffmpeg(args, what, { timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  try {
    await execFileP("ffmpeg", ["-loglevel", "error", "-y", ...args], { maxBuffer: 1 << 24, timeout: timeoutMs, killSignal: "SIGKILL" });
  } catch (err) {
    if (err?.killed) throw new VfError("INTERNAL", `ffmpeg ${what} ค้างเกิน ${Math.round(timeoutMs / 1000)} วินาที จึงถูกหยุด`, { timeoutMs });
    throw new VfError("INTERNAL", `ffmpeg ${what} ไม่สำเร็จ`, { cause: String(err?.stderr ?? err?.message ?? err).slice(0, 400) });
  }
}

let filterCache = null;
export function hasFilter(name) {
  if (filterCache === null) {
    try {
      filterCache = execFileSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      filterCache = "";
    }
  }
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(filterCache);
}

const VIDEO_OUT = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
const fit = (w, h) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;

// ช็อตวิดีโอ → ขนาด w×h, FPS เดียวกัน, เสียงสเตอริโอ 48k (ไม่มีเสียงก็เติมเงียบ) เพื่อให้ต่อแบบ copy ได้
export function normalizeArgs({ input, out, w, h, hasAudio, seconds }) {
  const audio = hasAudio ? ["-map", "0:a"] : ["-map", "1:a"];
  return [
    "-i", input, ...(hasAudio ? [] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
    "-vf", `${fit(w, h)},fps=${FPS},format=yuv420p`, "-map", "0:v", ...audio,
    "-af", `aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${seconds.toFixed(3)}`, "-t", seconds.toFixed(3),
    ...VIDEO_OUT, "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", out,
  ];
}

export function concatList(files) {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

export function concatArgs({ listFile, out }) {
  return ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", out];
}

// เสียงพากย์หลายท่อน วางตามเวลาเริ่ม (วินาที) เร่งตาม tempo แล้วรวมเป็นแทร็กเดียวยาว duration
// ไม่ใช้ apad: apad หลัง amix บางครั้งทำ ffmpeg 8 วนค้างไม่จบ หรือจบสั้นกว่าที่สั่ง (ตอนเครื่องหนัก)
// → ผสมกับเสียงเงียบยาว duration พอดีแทน ทุกแหล่งมีความยาวจำกัด
export function narrationTrackArgs({ items, duration, out }) {
  if (!items.length) throw new VfError("INTERNAL", "ไม่มีเสียงพากย์ให้รวม");
  const d = duration.toFixed(3);
  const inputs = [...items.flatMap((it) => ["-i", it.file]), "-f", "lavfi", "-t", d, "-i", "anullsrc=r=48000:cl=stereo"];
  const parts = items.map((it, i) => {
    const ms = Math.round(it.at * 1000);
    return `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,${it.tempo && it.tempo !== 1 ? `atempo=${it.tempo},` : ""}adelay=${ms}|${ms}[n${i}]`;
  });
  const labels = items.map((_, i) => `[n${i}]`).join("") + `[${items.length}:a]`;
  const graph = [...parts, `${labels}amix=inputs=${items.length + 1}:normalize=0:duration=longest,atrim=0:${d}[out]`].join(";");
  return [...inputs, "-filter_complex", graph, "-map", "[out]", "-ar", "48000", "-ac", "2", "-t", d, out];
}

// เพลงสั้นวนต่อกันด้วย crossfade จนยาวถึง duration (จ่ายเพลงแค่ท่อนเดียว)
export function loopMusicArgs({ src, srcSec, duration, out, xfade: want = 2 }) {
  if (!(srcSec > 0.5)) throw new VfError("INTERNAL", `เพลงสั้นเกินกว่าจะวน (${srcSec} วินาที)`);
  const xfade = Math.min(want, srcSec / 4);
  const copies = Math.max(1, Math.ceil((duration - xfade) / (srcSec - xfade)));
  const inputs = Array.from({ length: copies }, () => ["-i", src]).flat();
  const chain = [];
  let last = "[0:a]";
  for (let i = 1; i < copies; i++) {
    chain.push(`${last}[${i}:a]acrossfade=d=${xfade}:c1=tri:c2=tri[x${i}]`);
    last = `[x${i}]`;
  }
  const graph = [...chain, `${last}atrim=0:${duration.toFixed(3)}[out]`].join(";");
  return [...inputs, "-filter_complex", graph, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "128k", out];
}
