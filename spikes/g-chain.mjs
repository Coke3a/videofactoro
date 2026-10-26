// Spike g: take the last frame of a clip from spike c, use it as the keyframe of a second clip, build a contact sheet.
// Spend: 1 draft clip (about $0.06) + 1 R2 upload.
// Run (after spike c): node spikes/g-chain.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { run, extractMedia, download } from "../tools/cf.mjs";
import { uploadTemp } from "../tools/r2.mjs";
import { MODELS } from "../tools/models.mjs";
import { out, facts, timed } from "./_lib.mjs";

const first = ["c-r2url.mp4", "c-base64.mp4"].map(out).find((f) => fs.existsSync(f));
if (!first) throw new Error("run spikes/c-video.mjs first");
const lastFrame = out("g-last.png");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-sseof", "-0.05", "-i", first, "-frames:v", "1", lastFrame]);
const url = await uploadTemp(lastFrame);
const { value, ms } = await timed(() => run(MODELS.video, {
  mode: "i2v", duration: 5, aspect_ratio: "9:16", draft: true, generate_audio: false,
  prompt: "The cat keeps waving, then turns and walks away. No background music.", keyframes: url,
}, { timeoutMs: 180000 }));
const second = out("g-second.mp4");
await download(extractMedia(value.result), second);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-sseof", "-1", "-i", first, "-i", second,
  "-filter_complex", "[0:v]fps=3,scale=270:-2[a];[1:v]fps=3,scale=270:-2[b];[a][b]concat=n=2:v=1:a=0,tile=6x3",
  "-frames:v", "1", out("g-contact-sheet.png")]);
facts("g-chain", { ms, first, second, contact_sheet: out("g-contact-sheet.png"), note: "look at the sheet: first row ends clip 1, later frames start clip 2; check for a visible jump at the seam" });
