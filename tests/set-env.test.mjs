import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
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
