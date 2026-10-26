// Spike d: price units of flux-3-video. Generates one draft 5 s, one hd 5 s, one hd 10 s clip so the AI Gateway
// log/dashboard can be compared by hand afterwards (this script only records what to look for).
// Spend: about $0.06 + $0.17 + $0.34 if per-clip pricing is not per-second (up to about $0.6 total).
// Run (after spike a): node spikes/d-price.mjs
import fs from "node:fs";
import { run, extractMedia, download } from "../tools/cf.mjs";
import { uploadTemp } from "../tools/r2.mjs";
import { MODELS } from "../tools/models.mjs";
import { estimate } from "../tools/pricing.mjs";
import { out, facts, timed } from "./_lib.mjs";

const key = out("a-plain.png");
if (!fs.existsSync(key)) throw new Error("run spikes/a-klein.mjs first");
const url = await uploadTemp(key);
const result = { started_at: new Date().toISOString(), clips: [], next_step: "open AI Gateway logs, match by time, record cost per clip in RESULTS.md" };
for (const [label, extra] of [["draft-5s", { draft: true, duration: 5 }], ["hd-5s", { resolution: "hd", duration: 5 }], ["hd-10s", { resolution: "hd", duration: 10 }]]) {
  try {
    const { value, ms } = await timed(() => run(MODELS.video, { mode: "i2v", aspect_ratio: "9:16", generate_audio: false, prompt: "The cat waves. No background music.", keyframes: url, ...extra }, { timeoutMs: 180000 }));
    await download(extractMedia(value.result), out(`d-${label}.mp4`));
    result.clips.push({ label, at: new Date().toISOString(), ms });
  } catch (e) {
    result.clips.push({ label, error: String(e.message).slice(0, 300) });
  }
}
result.current_PRICES_estimate_example = (() => { try { return estimate(MODELS.video, { clips: 1 }); } catch (e) { return String(e.message); } })();
facts("d-price", result);
