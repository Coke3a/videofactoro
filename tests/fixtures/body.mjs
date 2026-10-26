// Request body as {model, input} whether cf.run sent JSON or multipart (multipart @cf models carry the model in the URL).
export function bodyOf(url, init = {}) {
  const b = init.body;
  if (!b) return null;
  if (!(b instanceof FormData)) return JSON.parse(b);
  const input = {};
  for (const [k, v] of b.entries()) input[k] = typeof v === "string" ? v : { bytes: v.size };
  const m = /\/ai\/run\/(@cf\/.+)$/.exec(new URL(url).pathname);
  return { model: m ? m[1] : input.model, input };
}
