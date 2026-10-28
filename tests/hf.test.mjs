process.env.VF_NO_DOTENV = "1";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, delimiter } from "node:path";
import { hfCommand, hfEnv, HF_ENV, HF_VERSION, HF_TIMEOUT_MS, binRunner, renderArgs, lintArgs, snapshotArgs, setRunner, hfLint, hfRender, hfSnapshot, hfBin, gsapFile } from "../tools/hf.mjs";
import { VfError } from "../tools/out.mjs";

afterEach(() => setRunner(null));

test("renderArgs", () => {
  assert.deepEqual(renderArgs({ dir: "/p", out: "/o.mp4" }), [
    "render", "/p", "-o", "/o.mp4", "--workers", "1", "--no-low-memory-mode", "--quality", "draft", "--strict", "--no-best-effort",
  ]);
});

test("lintArgs และ snapshotArgs", () => {
  assert.deepEqual(lintArgs({ dir: "/p" }), ["lint", "/p"]);
  assert.deepEqual(snapshotArgs({ dir: "/p", at: [2.9, 10.4], outDir: "/s" }), ["snapshot", "/p", "--at", "2.9,10.4", "-o", "/s", "--no-end"]);
  assert.equal(HF_VERSION, "0.8.153");
});

test("hfLint อ่านจำนวน warning", async () => {
  setRunner(async () => ({ stdout: "◇  0 error(s), 3 warning(s)", stderr: "" }));
  const r = await hfLint("/p");
  assert.equal(r.errors, 0);
  assert.equal(r.warnings, 3);
});

test("hfLint คืน errors ให้ผู้เรียกตัดสิน แม้ runner throw", async () => {
  setRunner(async () => ({ stdout: "◇  2 error(s), 0 warning(s)" }));
  assert.equal((await hfLint("/p")).errors, 2);
  setRunner(async () => { throw Object.assign(new Error("exit 1"), { stdout: "◇  2 error(s), 0 warning(s)" }); });
  assert.equal((await hfLint("/p")).errors, 2);
});

test("hfLint อ่านผลไม่ได้ → error", async () => {
  setRunner(async () => ({ stdout: "???" }));
  await assert.rejects(hfLint("/p"), { name: "VfError", code: "INTERNAL" });
});

test("runner ได้ HF_ENV ใน env", async () => {
  let seen;
  setRunner(async (args, opts) => { seen = opts; return { stdout: "" }; });
  const r = await hfRender("/p", "/o.mp4");
  assert.ok(r.seconds >= 0);
  for (const k of Object.keys(HF_ENV)) assert.equal(seen.env[k], "1");
});

test("hfSnapshot คืน path ของ png", async () => {
  const d = mkdtempSync(join(tmpdir(), "hf-"));
  writeFileSync(join(d, "b.png"), "x");
  writeFileSync(join(d, "a.png"), "x");
  writeFileSync(join(d, "n.txt"), "x");
  setRunner(async () => ({ stdout: "" }));
  assert.deepEqual(await hfSnapshot("/p", [1], d), [join(d, "a.png"), join(d, "b.png")]);
});

test("hfEnv/hfLint: tmpDir → TMPDIR/TMP/TEMP และสร้างโฟลเดอร์ให้", async () => {
  assert.equal(hfEnv({ PATH: "/x" }).TMPDIR, undefined);
  const t = join(mkdtempSync(join(tmpdir(), "hf-")), "a", ".tmp");
  assert.equal(hfEnv({ PATH: "/x" }, t).TEMP, t);
  let seen;
  setRunner(async (args, opts) => { seen = opts; return { stdout: "◇  0 error(s), 0 warning(s)" }; });
  await hfLint("/p", { tmpDir: t });
  for (const k of ["TMPDIR", "TMP", "TEMP"]) assert.equal(seen.env[k], t);
  assert.ok(existsSync(t));
});

test("hfBin/gsapFile ชี้ใต้ node_modules", () => {
  // ถ้าติดตั้งแล้วต้องเป็น absolute; ถ้ายังไม่ติดตั้งต้องเป็น CONFIG
  for (const f of [hfBin, gsapFile]) {
    try { assert.ok(f().includes("node_modules")); } catch (e) { assert.equal(e.code, "CONFIG"); }
  }
});

test("runner ล้มเหลว (ไม่ใช่ lint) → INTERNAL", async () => {
  setRunner(async () => { throw new Error("boom"); });
  await assert.rejects(hfRender("/p", "/o.mp4"), { name: "VfError", code: "INTERNAL" });
});

test("binRunner: hyperframes ค้างเกินเวลา → SIGKILL แล้วเป็น INTERNAL; hfRender ส่งต่อข้อความเดิม", async () => {
  const hang = binRunner(process.execPath, 300);
  const t0 = Date.now();
  await assert.rejects(hang(["-e", "setInterval(() => {}, 1000)"], { env: process.env }), (e) => e.code === "INTERNAL" && /ค้างเกิน/.test(e.message));
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(HF_TIMEOUT_MS, 30 * 60 * 1000);
  setRunner(async () => { throw new VfError("INTERNAL", "hyperframes render ค้างเกิน 1800 วินาที จึงถูกหยุด"); });
  await assert.rejects(hfRender("/p", "/o.mp4"), (e) => e.code === "INTERNAL" && /ค้างเกิน/.test(e.message));
});

test("hfCommand ใช้ process.execPath + entry JS ของ hyperframes", () => {
  let c;
  try { c = hfCommand(["lint", "/p"]); } catch (e) { assert.equal(e.code, "CONFIG"); return; }
  assert.equal(c.cmd, process.execPath);
  assert.equal(c.args[0], hfBin());
  assert.ok(!c.args[0].includes(".bin"));
  assert.deepEqual(c.args.slice(1), ["lint", "/p"]);
});

test("hfEnv: PATH ขึ้นต้นด้วย dir ของ node ที่รัน vf", async () => {
  const e = hfEnv({ PATH: "/usr/bin" });
  assert.equal(e.PATH, `${dirname(process.execPath)}${delimiter}/usr/bin`);
  assert.equal(e.HYPERFRAMES_NO_TELEMETRY, "1");
  let seen;
  setRunner(async (args, opts) => { seen = opts; return { stdout: "" }; });
  await hfRender("/p", "/o.mp4");
  assert.ok(seen.env.PATH.startsWith(dirname(process.execPath) + delimiter));
});
