// Spike a: klein 9:16 1k text-only, then with 1..4 reference images via R2 URLs.
// Spend: about 5 klein images at 1k (roughly $0.01 each) + 1 small R2 upload per ref.
// Run: node spikes/a-klein.mjs
import fs from "node:fs";
import { run, withRetry, extractMedia, download } from "../tools/cf.mjs";
import { uploadTemp } from "../tools/r2.mjs";
import { MODELS } from "../tools/models.mjs";
import { out, facts, timed, shape } from "./_lib.mjs";

const result = { plain: null, refs: [] };
const PROMPT = "A friendly orange cat mascot, full body, flat cartoon style, plain light background.";

async function gen(input) {
  const { value, ms } = await timed(() => withRetry(() => run(MODELS.image, input)));
  return { result: value.result, ms };
}

const plain = await gen({ prompt: PROMPT, aspect_ratio: "9:16", resolution: "1k", seed: 1 });
const media = extractMedia(plain.result);
await download(media, out("a-plain.png"));
const buf = fs.readFileSync(out("a-plain.png"));
result.plain = {
  ms: plain.ms, media_kind: media.kind, media_field: media.field, bytes: buf.length,
  width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), response_shape: shape(plain.result),
};

const refUrl = await uploadTemp(out("a-plain.png"));
for (const n of [1, 2, 3, 4]) {
  try {
    const r = await gen({ prompt: PROMPT + " Same character, waving.", aspect_ratio: "9:16", resolution: "1k", seed: 2, images: Array(n).fill(refUrl) });
    await download(extractMedia(r.result), out(`a-refs-${n}.png`));
    result.refs.push({ refs: n, ok: true, ms: r.ms });
  } catch (e) {
    result.refs.push({ refs: n, ok: false, error: String(e.message).slice(0, 300) });
  }
}
facts("a-klein", result);
