import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VfError } from "./out.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseInto(file) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]]) continue;
    const v = m[2].replace(/^["']|["']$/g, "");
    if (v !== "") process.env[m[1]] = v;
  }
}

// Walk up from startDir to find .env, then fall back to the repo-root .env. Never overrides existing env.
export function loadEnv(startDir = process.cwd()) {
  if (process.env.VF_NO_DOTENV === "1") return null;
  const candidates = [];
  for (let d = path.resolve(startDir); ; d = path.dirname(d)) {
    candidates.push(path.join(d, ".env"));
    if (path.dirname(d) === d) break;
  }
  candidates.push(path.join(REPO_ROOT, ".env"));
  const f = candidates.find((c) => fs.existsSync(c));
  if (!f) return null;
  parseInto(f);
  return f;
}

export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new VfError("CONFIG", `ยังไม่ได้ตั้ง: ${missing.join(", ")}`);
  return Object.fromEntries(names.map((n) => [n, process.env[n]]));
}

export function secretValues() {
  return Object.entries(process.env)
    .filter(([k, v]) => /TOKEN|SECRET|KEY|PASSWORD/.test(k) && v && v.length >= 8)
    .map(([, v]) => v);
}
