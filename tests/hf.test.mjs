process.env.VF_NO_DOTENV = "1";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HF_ENV, HF_VERSION, renderArgs, lintArgs, snapshotArgs, setRunner, hfLint, hfRender, hfSnapshot, hfBin, gsapFile } from "../tools/hf.mjs";

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
