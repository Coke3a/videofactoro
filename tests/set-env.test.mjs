import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../tools/set-env.sh", import.meta.url).pathname;
const ACCT = "0123456789abcdef0123456789abcdef";
const TOK = "a".repeat(40);
const R2 = "b".repeat(40);

function runScript(lines, existing) {
  const dir = mkdtempSync(join(tmpdir(), "vf-setenv-"));
  const file = join(dir, ".env");
  if (existing !== undefined) writeFileSync(file, existing);
  const r = spawnSync("bash", [script], { input: lines.join("\n") + "\n", encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, ENV_FILE: file } });
  return { r, file, dir };
}

test("set-env.sh เขียน .env chmod 600, เก็บบรรทัดอื่น, พิมพ์แค่ความยาว", () => {
  const { r, file, dir } = runScript([ACCT, TOK, "", R2, "", ""], "OTHER=keep\nVF_R2_BUCKET=old\n");
  try {
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes("OTHER=keep"));
    assert.ok(text.includes("VF_R2_BUCKET=videofactoro") && !text.includes("=old"));
    assert.ok(text.includes(`CLOUDFLARE_AI_API_TOKEN=${TOK}`));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    for (const v of [ACCT, TOK, R2]) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v));
    assert.match(r.stdout, /CLOUDFLARE_AI_API_TOKEN\s+ยาว 40/);
    assert.ok(r.stdout.includes("node bin/vf.mjs setup"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("set-env.sh ปฏิเสธรูปแบบผิดโดยไม่แตะไฟล์", () => {
  const { r, file, dir } = runScript(["nothex", TOK, "", R2, "", ""], "KEEP=1\n");
  try {
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(file, "utf8"), "KEEP=1\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean);

test("set-env.sh รันซ้ำไม่มีบรรทัดซ้ำ และ export NAME= ถูกแทนที่", () => {
  const { file, dir } = runScript([ACCT, TOK, "", R2, "", ""], `export CLOUDFLARE_AI_API_TOKEN=old\n  VF_R2_BUCKET = old\nKEEP=1\n`);
  try {
    const again = spawnSync("bash", [script], { input: [ACCT, TOK, "", R2, "", ""].join("\n") + "\n", encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, ENV_FILE: file } });
    assert.equal(again.status, 0, again.stderr);
    const l = lines(file);
    for (const n of ["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "VF_R2_BUCKET", "VF_R2_TOKEN"]) {
      assert.equal(l.filter((x) => new RegExp(`^(export\\s+)?${n}\\s*=`).test(x)).length, 1, n);
    }
    assert.ok(!readFileSync(file, "utf8").includes("old"));
    assert.ok(l.includes("KEEP=1"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("set-env.sh เปลี่ยนจาก access key เป็น token แล้วลบ key เก่า", () => {
  const { file, dir } = runScript([ACCT, TOK, "", R2, "", ""], "VF_R2_ACCESS_KEY_ID=OLDKEYID\nVF_R2_SECRET_ACCESS_KEY=OLDSECRET\n");
  try {
    const t = readFileSync(file, "utf8");
    assert.ok(!t.includes("OLDKEYID") && !t.includes("OLDSECRET"));
    assert.ok(t.includes(`VF_R2_TOKEN=${R2}`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("set-env.sh ตรวจไม่ผ่าน -> ไม่สร้างไฟล์ และไม่มี temp ค้าง", () => {
  const { r, file, dir } = runScript(["nothex", TOK, "", R2, "", ""]);
  try {
    assert.notEqual(r.status, 0);
    assert.deepEqual(readdirSync(dir), []);
    assert.ok(!existsSync(file));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
