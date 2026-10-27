// ประกอบวิดีโอหลายช็อตด้วย ffmpeg: ปรับทุกช็อตให้ขนาด/fps/เสียงเท่ากัน, ต่อกัน, ภาพนิ่งเคลื่อนไหว (motion),
// รางเสียงพากย์ตามเวลา และตัวหนังสือแบบ ASS (ต้องมี ffmpeg ที่มี libass; ถ้าไม่มีจะข้ามตัวหนังสือพร้อมคำเตือน)
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { VfError } from "./out.mjs";

const execFileP = promisify(execFile);

export const FPS = 24;
export const MOVES = ["zoom_in", "zoom_out", "pan_left", "pan_right", "tilt_up", "crash_zoom", "shake", "bounce"];

export function frameSize(aspect) {
  if (aspect === "16:9") return { w: 1280, h: 720 };
  if (aspect === "1:1") return { w: 960, h: 960 };
  return { w: 720, h: 1280 };
}

export async function ffmpeg(args, what) {
  try {
    await execFileP("ffmpeg", ["-loglevel", "error", "-y", ...args], { maxBuffer: 1 << 24 });
  } catch (err) {
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
    "-af", "aresample=48000,aformat=channel_layouts=stereo,apad", "-t", seconds.toFixed(3),
    ...VIDEO_OUT, "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", out,
  ];
}

// ภาพนิ่ง → คลิปเคลื่อนไหว seconds วินาที (ขยายภาพ 2 เท่าก่อน zoompan เพื่อไม่ให้สั่นเป็นขั้นบันได)
// กล้องเคลื่อนแบบ smoothstep + ขยับเบาๆ แบบถือกล้อง; hit (วินาที) = จังหวะพีก: punch-in และภาพสั่นที่ค่อยๆ หยุด + แฟลชขาว
// ตัดชนกันตรงๆ ไม่ fade จากดำ (เคยกระพริบดำทุกฉาก) ยกเว้นฉากแรกของคลิป
export function stillMotionArgs({ image, out, w, h, seconds, move, hit = null, first = false }) {
  const n = Math.max(1, Math.round(seconds * FPS));
  const e = `(on/${n})*(on/${n})*(3-2*on/${n})`;
  const k = hit === null ? Math.round(n * 0.35) : Math.min(n - 1, Math.round(hit * FPS));
  const q = Math.max(1, Math.round(n * 0.2));
  const cx = "iw/2-(iw/zoom/2)+6*sin(on/9)";
  const cy = "ih/2-(ih/zoom/2)+5*cos(on/13)";
  const decay = (tau) => `exp(-(on-${k})/${tau})`;
  const expr = {
    zoom_in: [`1.04+0.16*${e}`, cx, cy],
    zoom_out: [`1.2-0.16*${e}`, cx, cy],
    pan_left: ["1.15", `(iw-iw/zoom)*(1-${e})`, cy],
    pan_right: ["1.15", `(iw-iw/zoom)*${e}`, cy],
    tilt_up: ["1.15", cx, `(ih-ih/zoom)*(1-${e})`],
    crash_zoom: [`1.04+0.3*(1-pow(1-min(on/${q},1),3))+0.03*on/${n}`, cx, cy],
    shake: ["1.12", `${cx}+if(gte(on,${k}),40*${decay(8)}*sin(on*2.3),0)`, `${cy}+if(gte(on,${k}),30*${decay(8)}*cos(on*3.1),0)`],
    bounce: [`1.06+0.05*abs(sin(on*PI*2/${FPS}))`, cx, cy],
  }[move] ?? [`1.04+0.16*${e}`, cx, cy];
  const [z0, x, y] = expr;
  const z = hit === null ? z0 : `${z0}+if(gte(on,${k}),0.08*${decay(5)},0)`;
  const hitEnd = Math.round((hit + 0.1) * 1000) / 1000;
  const flash = hit === null ? "" : `,eq=brightness='if(between(t,${hit},${hitEnd}),0.45*(1-(t-${hit})/0.1),0)':eval=frame`;
  return [
    "-i", image,
    "-vf", `${fit(w * 2, h * 2)},zoompan=z='${z}':x='${x}':y='${y}':d=${n}:s=${w}x${h}:fps=${FPS}${flash}${first ? ",fade=t=in:st=0:d=0.3" : ""},format=yuv420p`,
    "-frames:v", String(n), "-an", ...VIDEO_OUT, out,
  ];
}

export function concatList(files) {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

export function concatArgs({ listFile, out }) {
  return ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", out];
}

// เสียงพากย์หลายท่อน วางตามเวลาเริ่ม (วินาที) เร่งตาม tempo แล้วรวมเป็นแทร็กเดียวยาว duration
export function narrationTrackArgs({ items, duration, out }) {
  if (!items.length) throw new VfError("INTERNAL", "ไม่มีเสียงพากย์ให้รวม");
  const inputs = items.flatMap((it) => ["-i", it.file]);
  const parts = items.map((it, i) => {
    const ms = Math.round(it.at * 1000);
    return `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,${it.tempo && it.tempo !== 1 ? `atempo=${it.tempo},` : ""}adelay=${ms}|${ms}[n${i}]`;
  });
  const labels = items.map((_, i) => `[n${i}]`).join("");
  const graph = [...parts, `${labels}amix=inputs=${items.length}:normalize=0:duration=longest,apad,atrim=0:${duration.toFixed(3)}[out]`].join(";");
  return [...inputs, "-filter_complex", graph, "-map", "[out]", "-ar", "48000", "-ac", "2", out];
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

// ---------- ตัวหนังสือ (ASS) ----------

const assTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
export const assText = (t) => String(t).replace(/[{}\\]/g, "").replace(/\r?\n/g, "\\N").trim();

export function fontFor(lang) {
  if (process.env.VF_FONT) return process.env.VF_FONT;
  return /^th/i.test(String(lang)) ? "Loma" : "DejaVu Sans";
}

// events: {start, end, text, style: Caption|Card|Sfx|Title}
export function assScript({ w, h, font, events }) {
  const sz = (k) => Math.round(h * k);
  // สี ASS = &HAABBGGRR
  const styles = [
    `Style: Caption,${font},${sz(0.042)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${Math.max(3, sz(0.004))},2,2,40,40,${sz(0.11)},1`,
    `Style: Card,${font},${sz(0.13)},&H0000E5FF,&H0000E5FF,&H00202020,&H64000000,-1,0,0,0,100,100,0,0,1,${sz(0.007)},4,5,20,20,20,1`,
    `Style: Sfx,${font},${sz(0.085)},&H003B5BFF,&H003B5BFF,&H00FFFFFF,&H64000000,-1,0,0,0,100,100,0,0,1,${sz(0.006)},3,8,20,20,${sz(0.2)},1`,
    `Style: Title,${font},${sz(0.055)},&H00FFFFFF,&H00FFFFFF,&H00C04A1E,&H64000000,-1,0,0,0,100,100,0,0,1,${sz(0.006)},3,8,40,40,${sz(0.08)},1`,
  ];
  const fx = {
    Caption: "{\\fad(120,120)}",
    Card: "{\\fscx40\\fscy40\\t(0,180,\\fscx118\\fscy118)\\t(180,320,\\fscx100\\fscy100)\\fad(0,150)}",
    Sfx: "{\\frz-8\\fscx30\\fscy30\\t(0,140,\\fscx125\\fscy125)\\t(140,260,\\fscx100\\fscy100)\\fad(0,120)}",
    Title: "{\\fad(200,200)}",
  };
  const lines = events
    .filter((e) => e.text && e.end > e.start)
    .map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${fx[e.style] ?? ""}${assText(e.text)}`);
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${w}`, `PlayResY: ${h}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles, "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines, "",
  ].join("\n");
}

const filterPath = (p) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

export function burnArgs({ input, assFile, out }) {
  return ["-i", input, "-vf", `ass='${filterPath(assFile)}'`, ...VIDEO_OUT, "-c:a", "copy", "-movflags", "+faststart", out];
}

export function writeAss(file, opts) {
  writeFileSync(file, assScript(opts));
  return file;
}
