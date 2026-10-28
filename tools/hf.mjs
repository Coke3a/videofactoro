import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { VfError } from "./out.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

export const HF_VERSION = "0.8.153";
export const HF_ENV = {
  HYPERFRAMES_NO_TELEMETRY: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  HYPERFRAMES_SKIP_SKILLS: "1",
};

export function hfBin() {
  const p = join(REPO_ROOT, "node_modules", ".bin", "hyperframes");
  if (!existsSync(p)) throw new VfError("CONFIG", "ยังไม่ได้ติดตั้ง hyperframes", { hint: "vf setup" });
  return p;
}

export function gsapFile() {
  const p = join(REPO_ROOT, "node_modules", "gsap", "dist", "gsap.min.js");
  if (!existsSync(p)) throw new VfError("CONFIG", "ยังไม่ได้ติดตั้ง gsap", { hint: "vf setup" });
  return p;
}

// เครื่อง 2 vCPU: worker เดียว, draft, ห้ามข้ามเฟรมเงียบ ๆ
export const renderArgs = ({ dir, out }) => [
  "render", dir, "-o", out,
  "--workers", "1", "--no-low-memory-mode", "--quality", "draft", "--strict", "--no-best-effort",
];
export const lintArgs = ({ dir }) => ["lint", dir];
// --no-end: เอาเฉพาะเฟรมที่ขอ ไม่เติมเฟรมท้ายเอง
export const snapshotArgs = ({ dir, at, outDir }) => ["snapshot", dir, "--at", at.join(","), "-o", outDir, "--no-end"];

// render ที่ค้าง (Chrome ไม่ตอบ) ต้องไม่ถือเครื่องไว้ตลอดไป → หมดเวลาแล้ว SIGKILL
export const HF_TIMEOUT_MS = 30 * 60 * 1000;

export const binRunner = (bin, timeoutMs = HF_TIMEOUT_MS) => async (args, { env } = {}) => {
  try {
    return await run(bin, args, { env, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" });
  } catch (err) {
    if (err?.killed) throw new VfError("INTERNAL", `hyperframes ${args[0]} ค้างเกิน ${Math.round(timeoutMs / 1000)} วินาที จึงถูกหยุด`, { timeoutMs });
    throw err;
  }
};

const defaultRunner = (args, opts) => binRunner(hfBin())(args, opts);

let runner = defaultRunner;
export const setRunner = (fn) => { runner = fn ?? defaultRunner; };

const text = (r) => (typeof r === "string" ? r : `${r?.stdout ?? ""}${r?.stderr ? `\n${r.stderr}` : ""}`);

// lint ที่เจอ error ออก exit != 0 → ยังอ่านผลจาก stdout ของ error ได้
async function exec(args) {
  const env = { ...process.env, ...HF_ENV };
  try {
    return text(await runner(args, { env }));
  } catch (err) {
    if (err instanceof VfError) throw err;
    if (args[0] === "lint" && (err?.stdout || err?.stderr)) return text(err);
    throw new VfError("INTERNAL", `hyperframes ${args[0]} ล้มเหลว: ${String(err?.stderr || err?.message || err).slice(0, 400)}`);
  }
}

export async function hfLint(dir) {
  const out = await exec(lintArgs({ dir }));
  const m = /(\d+)\s+error\(s\),\s*(\d+)\s+warning\(s\)/.exec(out);
  if (!m) throw new VfError("INTERNAL", "อ่านผล hyperframes lint ไม่ได้", { text: out.slice(0, 400) });
  return { errors: Number(m[1]), warnings: Number(m[2]), text: out };
}

export async function hfRender(dir, out) {
  const t0 = Date.now();
  await exec(renderArgs({ dir, out }));
  return { seconds: (Date.now() - t0) / 1000 };
}

export async function hfSnapshot(dir, at, outDir) {
  await exec(snapshotArgs({ dir, at, outDir }));
  return readdirSync(outDir).filter((f) => f.endsWith(".png")).sort().map((f) => join(outDir, f));
}
