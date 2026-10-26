// Spike a: flux-2-klein-9b 9:16 (768x1360) text-only, then with 1..4 reference images sent inline as multipart parts.
// Spend: about 5 images at ~1 MP ($0.015 each + $0.002 per ref MP).
// Run: node spikes/a-klein.mjs
import fs from "node:fs";
import { run, withRetry, extractMedia, download } from "../tools/cf.mjs";
import { MODELS } from "../tools/models.mjs";
import { out, facts, timed, shape } from "./_lib.mjs";

const result = { plain: null, refs: [] };
const PROMPT = "A friendly orange cat mascot, full body, flat cartoon style, plain light background.";

async function gen(input, refs = []) {
  refs.forEach((b, i) => { input[`input_image_${i}`] = b; });
  const { value, ms } = await timed(() => withRetry(() => run(MODELS.image, input, { multipart: true })));
  return { result: value.result, ms };
}

const SIZE = { width: "768", height: "1360" };
const plain = await gen({ prompt: PROMPT, ...SIZE, seed: "1" });
const media = extractMedia(plain.result);
await download(media, out("a-plain.jpg"));
const buf = fs.readFileSync(out("a-plain.jpg"));
result.plain = {
  ms: plain.ms, media_kind: media.kind, media_field: media.field, bytes: buf.length,
  magic: buf.subarray(0, 4).toString("hex"), response_shape: shape(plain.result),
};

for (const n of [1, 2, 3, 4]) {
  try {
    const r = await gen({ prompt: PROMPT + " Same character, waving.", ...SIZE, seed: "2" }, Array(n).fill(buf));
    await download(extractMedia(r.result), out(`a-refs-${n}.jpg`));
    result.refs.push({ refs: n, ok: true, ms: r.ms });
  } catch (e) {
    result.refs.push({ refs: n, ok: false, error: String(e.message).slice(0, 300) });
  }
}
facts("a-klein", result);
