// Shared helpers for throwaway spikes. Not part of the product.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../tools/env.mjs";
import { redact } from "../tools/out.mjs";

export const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
fs.mkdirSync(OUT, { recursive: true });
loadEnv();

export const out = (...p) => path.join(OUT, ...p);
export const facts = (name, obj) => {
  const text = redact(JSON.stringify(obj, null, 2));
  fs.writeFileSync(out(`${name}.json`), text);
  console.log(text);
};
export const timed = async (fn) => {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
};
export const shape = (v, depth = 0) => {
  if (typeof v === "string") return v.length > 80 ? `<string ${v.length} chars: ${v.slice(0, 20)}...>` : v;
  if (Array.isArray(v)) return depth > 3 ? "<array>" : v.slice(0, 5).map((x) => shape(x, depth + 1));
  if (v && typeof v === "object") {
    return depth > 3 ? "<object>" : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return v;
};
export const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
