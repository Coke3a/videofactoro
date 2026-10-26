// Spike e: real request/response shape of bria/remove-background (tries base64, then multipart).
// Spend: up to 2 background removals (about $0.01 each or less).
// Run (after spike a): node spikes/e-rmbg.mjs
import fs from "node:fs";
import { run, extractMedia, download } from "../tools/cf.mjs";
import { MODELS } from "../tools/models.mjs";
import { out, facts, timed, shape } from "./_lib.mjs";

const key = out("a-plain.jpg");
if (!fs.existsSync(key)) throw new Error("run spikes/a-klein.mjs first");
const b64 = fs.readFileSync(key).toString("base64");
const result = { attempts: [] };
for (const [name, input, opts] of [
  ["image_base64", { image: b64 }, {}],
  ["multipart", { image: fs.readFileSync(key) }, { multipart: true }],
]) {
  try {
    const { value, ms } = await timed(() => run(MODELS.rmbg, input, opts));
    const media = extractMedia(value.result);
    await download(media, out(`e-${name}.png`));
    result.attempts.push({ name, ok: true, ms, input_keys: Object.keys(input), media_kind: media.kind, response_shape: shape(value.result) });
    break;
  } catch (e) {
    result.attempts.push({ name, ok: false, error: String(e.message).slice(0, 300) });
  }
}
facts("e-rmbg", result);
