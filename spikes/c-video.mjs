// Spike c: flux-3-video i2v, one keyframe, 5 s, draft:true. Compare R2 URL vs raw base64 keyframe; check audio.
// Spend: 2 draft clips (about $0.06 each per genhaha notes) + 1 klein image if spikes/out/a-plain.png is missing.
// Run (after spike a): node spikes/c-video.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { run, extractMedia, download } from "../tools/cf.mjs";
import { uploadTemp } from "../tools/r2.mjs";
import { MODELS } from "../tools/models.mjs";
import { out, facts, timed, shape } from "./_lib.mjs";

const key = out("a-plain.png");
if (!fs.existsSync(key)) throw new Error("run spikes/a-klein.mjs first");
const base = { mode: "i2v", duration: 5, aspect_ratio: "9:16", draft: true, generate_audio: true, prompt: "The cat waves and smiles. No background music." };
const result = {};

async function attempt(name, keyframes) {
  try {
    const { value, ms } = await timed(() => run(MODELS.video, { ...base, keyframes }, { timeoutMs: 120000 }));
    const media = extractMedia(value.result);
    const file = out(`c-${name}.mp4`);
    await download(media, file);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8" }));
    result[name] = {
      ok: true, ms, run_ms: value.ms, media_kind: media.kind, response_shape: shape(value.result),
      streams: probe.streams.map((s) => ({ type: s.codec_type, codec: s.codec_name, w: s.width, h: s.height, dur: s.duration })),
      has_audio: probe.streams.some((s) => s.codec_type === "audio"),
    };
  } catch (e) {
    result[name] = { ok: false, error: String(e.message).slice(0, 400), details: e.details };
  }
}

await attempt("r2url", await uploadTemp(key));
await attempt("base64", fs.readFileSync(key).toString("base64"));
facts("c-video", result);
