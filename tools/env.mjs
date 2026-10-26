import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VfError } from "./out.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const envPath = (root = REPO_ROOT) => path.join(root, ".env");

function parseInto(file) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]]) continue;
    const v = m[2].replace(/^["']|["']$/g, "");
    if (v !== "") process.env[m[1]] = v;
  }
}

// spec §12: env ของ process ก่อน แล้วจึง .env ที่ root ของ repo เท่านั้น (ไม่ไล่หาจาก cwd) · ไม่ทับค่าที่มีอยู่
export function loadEnv(root = REPO_ROOT) {
  if (process.env.VF_NO_DOTENV === "1") return null;
  const f = envPath(root);
  if (!fs.existsSync(f)) return null;
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
