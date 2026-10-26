import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, envPath, requireEnv, secretValues } from "../tools/env.mjs";

function tmpEnv(content) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vf-env-"));
  fs.writeFileSync(path.join(d, ".env"), content);
  return d;
}
function clean(...names) { for (const n of names) delete process.env[n]; }

test("loadEnv ไม่ทับค่าที่มีอยู่แล้ว", () => {
  const d = tmpEnv("X_TEST=b\n");
  process.env.X_TEST = "a";
  try {
    assert.equal(loadEnv(d), path.join(d, ".env"));
    assert.equal(process.env.X_TEST, "a");
  } finally { clean("X_TEST"); fs.rmSync(d, { recursive: true }); }
});

test("loadEnv ตัด quote", () => {
  const d = tmpEnv('Y_TEST="v"\nW_TEST=\'w\'\n');
  try {
    loadEnv(d);
    assert.equal(process.env.Y_TEST, "v");
    assert.equal(process.env.W_TEST, "w");
  } finally { clean("Y_TEST", "W_TEST"); fs.rmSync(d, { recursive: true }); }
});

test("requireEnv บอกชื่อที่ขาดเท่านั้น", () => {
  delete process.env.Z_MISSING;
  process.env.Z_PRESENT = "secretvalue123";
  try {
    assert.throws(() => requireEnv(["Z_PRESENT", "Z_MISSING"]), (e) => {
      assert.equal(e.code, "CONFIG");
      assert.match(e.message, /Z_MISSING/);
      assert.doesNotMatch(e.message, /Z_PRESENT|secretvalue123/);
      return true;
    });
    assert.deepEqual(requireEnv(["Z_PRESENT"]), { Z_PRESENT: "secretvalue123" });
  } finally { clean("Z_PRESENT"); }
});

test("secretValues เก็บเฉพาะชื่อที่เป็นความลับ", () => {
  process.env.FOO_TOKEN = "abcdefgh123";
  process.env.FOO_NAME = "namevalue999";
  process.env.BAR_KEY = "short";
  try {
    const v = secretValues();
    assert.ok(v.includes("abcdefgh123"));
    assert.ok(!v.includes("namevalue999"));
    assert.ok(!v.includes("short"));
  } finally { clean("FOO_TOKEN", "FOO_NAME", "BAR_KEY"); }
});

test("VF_NO_DOTENV=1 ไม่โหลดไฟล์ใดเลย", () => {
  const d = tmpEnv("NODOT_TEST=x\n");
  process.env.VF_NO_DOTENV = "1";
  try {
    assert.equal(loadEnv(d), null);
    assert.equal(process.env.NODOT_TEST, undefined);
  } finally { clean("VF_NO_DOTENV", "NODOT_TEST"); fs.rmSync(d, { recursive: true }); }
});

test("loadEnv อ่านเฉพาะ .env ที่ root (repo) ไม่ไล่หา .env ใน cwd หรือโฟลเดอร์แม่", () => {
  const outer = tmpEnv("CWD_TEST=from-cwd\n");
  const root = path.join(outer, "repo");
  fs.mkdirSync(root);
  const prev = process.cwd();
  process.chdir(outer);
  try {
    assert.equal(loadEnv(root), null);
    assert.equal(process.env.CWD_TEST, undefined);
    fs.writeFileSync(path.join(root, ".env"), "CWD_TEST=from-root\n");
    assert.equal(loadEnv(root), path.join(root, ".env"));
    assert.equal(process.env.CWD_TEST, "from-root");
  } finally { process.chdir(prev); clean("CWD_TEST"); fs.rmSync(outer, { recursive: true }); }
});

test("ค่าเริ่มต้นของไฟล์ .env คือ <repo>/.env (ไม่เปิดไฟล์)", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(envPath(), path.join(repo, ".env"));
});
