// เสียงของคลิป: พากย์ (Gemini TTS), เพลง (ElevenLabs Music v2), และ mix ด้วย ffmpeg (spec §6.2 ขั้น 8)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { run, withRetry, extractMedia, download } from "./cf.mjs";
import { MODELS } from "./models.mjs";
import { estimate } from "./pricing.mjs";
import { logCost, costRow, failOutcome } from "./cost.mjs";
import { VfError } from "./out.mjs";

const execFileP = promisify(execFile);

// ElevenLabs Music v2 รับความยาว 10 วินาทีขึ้นไป
export const MUSIC_MIN_SEC = 10;
// คลิปยาวกว่านี้: สร้างเพลงแค่ท่อนเดียวแล้ววนต่อ (เพลงคิดเงินต่อวินาที)
export const MUSIC_LOOP_SEC = 30;
export const MUSIC_GAIN = 0.6;
export const MUSIC_GAIN_UNDER_VOICE = 0.4;
export const NARRATION_DELAY_SEC = 0.3;
export const MAX_TEMPO = 1.3;

export async function mediaInfo(file) {
  let stdout;
  try {
    ({ stdout } = await execFileP("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file]));
  } catch (err) {
    throw new VfError("INTERNAL", `อ่านข้อมูลไฟล์ไม่ได้: ${file}`, { cause: String(err?.message ?? err).slice(0, 200) });
  }
  const j = JSON.parse(stdout);
  return { duration: Number(j.format?.duration) || 0, hasAudio: (j.streams ?? []).some((s) => s.codec_type === "audio") };
}

async function paid(model, input, { meta, costDir, step, units, usdOf, out }) {
  const row = costRow(meta, model, step);
  let result;
  try {
    ({ result } = await withRetry(() => run(model, input, { meta: { ...meta, step } })));
    await download(extractMedia(result), out);
  } catch (err) {
    logCost(costDir, { ...row, outcome: failOutcome(err), units, usd: null });
    throw err;
  }
  const info = await mediaInfo(out);
  logCost(costDir, { ...row, outcome: "ok", units: units(info), usd: usdOf(info) });
  return info;
}

// input มีแค่ text + voice (genhaha ttsAudio.ts: ใส่ field อื่นได้ 400)
export function tts({ text, voice, out, meta, costDir }) {
  return paid(MODELS.tts, { text, voice }, {
    meta, costDir, step: "narration", out,
    units: (info) => ({ seconds: info?.duration ?? null }),
    usdOf: (info) => estimate(MODELS.tts, { seconds: info.duration }),
  });
}

export function music({ prompt, seconds, out, meta, costDir, loop = false }) {
  const secs = Math.max(MUSIC_MIN_SEC, Math.ceil(seconds));
  const loopNote = loop ? " Seamless loop: steady groove from the first beat, no intro, no build-up, no ending." : "";
  return paid(MODELS.music, {
    prompt: `${prompt} Instrumental background music for a short video, no vocals, no loud lead melody.${loopNote}`,
    music_length_ms: secs * 1000, force_instrumental: true, output_format: "mp3_44100_128",
  }, {
    meta, costDir, step: "music", out,
    units: () => ({ seconds: secs }),
    usdOf: () => estimate(MODELS.music, { seconds: secs }),
  });
}

// คำบรรยายยาวกว่าที่ว่างในคลิป: เร่งได้ไม่เกิน MAX_TEMPO ที่เหลือจะถูกตัดตอนจบคลิป
export function narrationTempo(narrationSec, clipSec) {
  const room = clipSec - NARRATION_DELAY_SEC - 0.2;
  if (!(narrationSec > room) || room <= 0) return 1;
  return Math.min(MAX_TEMPO, Math.round((narrationSec / room) * 100) / 100);
}

// ffmpeg args: วิดีโอ copy, เสียงในฉาก + พากย์ (หน่วง 0.3 วิ) + เพลง (fade, หลบใต้เสียงพากย์) + เสียงประกอบ, ยาวเท่าวิดีโอ
// ปรับความดังรวมเป็น -14 LUFS (ระดับของแพลตฟอร์มคลิปสั้น) เพราะแต่ละแทร็กมาจากหลายแหล่ง ดังไม่เท่ากัน
const MIX_TIMEOUT_MS = 10 * 60 * 1000;

export function mixArgs({ video, duration, sceneAudio, narration, tempo = 1, music, musicGain, sfx = null, sfxGain = 0.55, out }) {
  const inputs = ["-i", video];
  const filters = [];
  const parts = [];
  if (sceneAudio) parts.push("[0:a]volume=1.0[scene]");
  let n = 1;
  let voiceLabel = null;
  if (narration) {
    inputs.push("-i", narration);
    const ms = Math.round(NARRATION_DELAY_SEC * 1000);
    // apad ต้องมีขอบเขต (apad เปล่าทำ ffmpeg 8 ค้างได้)
    const tail = music ? `,apad=whole_dur=${duration.toFixed(2)},asplit=2[voice][voicekey]` : "[voice]";
    filters.push(`[${n}:a]${tempo !== 1 ? `atempo=${tempo},` : ""}adelay=${ms}|${ms}${tail}`);
    voiceLabel = "voice";
    n++;
  }
  if (music) {
    inputs.push("-i", music);
    const fadeOut = Math.max(0, duration - 1).toFixed(2);
    filters.push(`[${n}:a]atrim=0:${duration.toFixed(2)},afade=t=in:d=0.5,afade=t=out:st=${fadeOut}:d=1,volume=${musicGain}[musicraw]`);
    if (voiceLabel) filters.push("[musicraw][voicekey]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=400[music]");
    else filters.push("[musicraw]anull[music]");
    n++;
  }
  if (sfx) {
    inputs.push("-i", sfx);
    filters.push(`[${n}:a]volume=${sfxGain}[sfx]`);
    n++;
  }
  const labels = [...(sceneAudio ? ["[scene]"] : []), ...(voiceLabel ? ["[voice]"] : []), ...(music ? ["[music]"] : []), ...(sfx ? ["[sfx]"] : [])];
  if (!labels.length) throw new VfError("INTERNAL", "mix ต้องมีเสียงอย่างน้อยหนึ่งแทร็ก");
  const graph = [...parts, ...filters, `${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,atrim=0:${duration.toFixed(2)},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`].join(";");
  return ["-loglevel", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", duration.toFixed(2), out];
}

export async function mix(opts) {
  try {
    await execFileP("ffmpeg", mixArgs(opts), { maxBuffer: 1 << 24, timeout: MIX_TIMEOUT_MS, killSignal: "SIGKILL" });
  } catch (err) {
    if (err?.killed) throw new VfError("INTERNAL", `ผสมเสียงค้างเกิน ${MIX_TIMEOUT_MS / 1000} วินาที จึงถูกหยุด`);
    throw new VfError("INTERNAL", "ผสมเสียงไม่สำเร็จ", { cause: String(err?.stderr ?? err?.message ?? err).slice(0, 300) });
  }
  return opts.out;
}
