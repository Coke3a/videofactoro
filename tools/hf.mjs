import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
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

// หา entry JS ของ hyperframes จาก package.json bin (ไม่ใช้ shim .bin เพราะ shebang จะเลือก node ของระบบ)
export function hfBin() {
  const pkgPath = join(REPO_ROOT, "node_modules", "hyperframes", "package.json");
  if (!existsSync(pkgPath)) throw new VfError("CONFIG", "ยังไม่ได้ติดตั้ง hyperframes", { hint: "vf setup" });
  const bin = JSON.parse(readFileSync(pkgPath, "utf8")).bin;
  const rel = typeof bin === "string" ? bin : bin?.hyperframes;
  const p = rel && join(dirname(pkgPath), rel);
  if (!p || !existsSync(p)) throw new VfError("CONFIG", "ไม่พบ entry ของ hyperframes", { hint: "vf setup" });
  return p;
}

// รันด้วย node ตัวเดียวกับ vf (ระบบอาจมี node เก่ากว่า 22 บน PATH)
export const hfCommand = (args) => ({ cmd: process.execPath, args: [hfBin(), ...args] });
// tmpDir: /tmp ของ sandbox เป็น tmpfs เล็ก (512 MB) แต่ render เขียนไฟล์ชั่วคราวใหญ่ → ชี้ไปดิสก์โปรเจกต์
export const hfEnv = (base = process.env, tmpDir) => ({
  ...base,
  ...HF_ENV,
  ...(tmpDir ? { TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir } : {}),
  PATH: [dirname(process.execPath), base.PATH].filter(Boolean).join(delimiter),
});

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
    if (err?.killed) throw new VfError("INTERNAL", `hyperframes ${args.find((a) => !a.endsWith(".mjs")) ?? args[0]} ค้างเกิน ${Math.round(timeoutMs / 1000)} วินาที จึงถูกหยุด`, { timeoutMs });
    throw err;
  }
};

const defaultRunner = (args, opts) => binRunner(process.execPath)([hfBin(), ...args], opts);

let runner = defaultRunner;
export const setRunner = (fn) => { runner = fn ?? defaultRunner; };

const text = (r) => (typeof r === "string" ? r : `${r?.stdout ?? ""}${r?.stderr ? `\n${r.stderr}` : ""}`);

// lint ที่เจอ error ออก exit != 0 → ยังอ่านผลจาก stdout ของ error ได้
async function exec(args, { tmpDir } = {}) {
  if (tmpDir) mkdirSync(tmpDir, { recursive: true });
  const env = hfEnv(process.env, tmpDir);
  try {
    return text(await runner(args, { env }));
  } catch (err) {
    if (err instanceof VfError) throw err;
    if (args[0] === "lint" && (err?.stdout || err?.stderr)) return text(err);
    throw new VfError("INTERNAL", `hyperframes ${args[0]} ล้มเหลว: ${String(err?.stderr || err?.message || err).slice(0, 400)}`);
  }
}

export async function hfLint(dir, opts) {
  const out = await exec(lintArgs({ dir }), opts);
  const m = /(\d+)\s+error\(s\),\s*(\d+)\s+warning\(s\)/.exec(out);
  if (!m) throw new VfError("INTERNAL", "อ่านผล hyperframes lint ไม่ได้", { text: out.slice(0, 400) });
  return { errors: Number(m[1]), warnings: Number(m[2]), text: out };
}

export async function hfRender(dir, out, opts) {
  const t0 = Date.now();
  await exec(renderArgs({ dir, out }), opts);
  return { seconds: (Date.now() - t0) / 1000 };
}

export async function hfSnapshot(dir, at, outDir, opts) {
  await exec(snapshotArgs({ dir, at, outDir }), opts);
  return readdirSync(outDir).filter((f) => f.endsWith(".png")).sort().map((f) => join(outDir, f));
}
