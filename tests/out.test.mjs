import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { redact, VfError } from "../tools/out.mjs";

process.env.VF_NO_DOTENV = "1";
const outUrl = new URL("../tools/out.mjs", import.meta.url).href;

function run(code, env = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("redact ลบค่า token", () => {
  process.env.CLOUDFLARE_AI_API_TOKEN = "tok_secret_123456";
  try {
    assert.equal(redact("Bearer tok_secret_123456 failed"), "Bearer *** failed");
  } finally {
    delete process.env.CLOUDFLARE_AI_API_TOKEN;
  }
});

test("fail ให้ exit code ตาม code", () => {
  const r = run(`import {fail,VfError} from ${JSON.stringify(outUrl)}; fail(new VfError('CONFIG','x'))`);
  assert.equal(r.status, 3);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.error.code, "CONFIG");
});

test("fail ของ error ทั่วไปเป็น INTERNAL", () => {
  const r = run(`import {fail} from ${JSON.stringify(outUrl)}; fail(new Error('boom'))`);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).error.code, "INTERNAL");
});

test("fail redact ความลับใน message", () => {
  const r = run(
    `import {fail,VfError} from ${JSON.stringify(outUrl)}; fail(new VfError('PROVIDER','bad tok_secret_123456'))`,
    { CLOUDFLARE_AI_API_TOKEN: "tok_secret_123456" },
  );
  assert.equal(r.status, 5);
  assert.ok(!r.stdout.includes("tok_secret_123456"));
  assert.ok(r.stdout.includes("***"));
});

test("emit พิมพ์ JSON บรรทัดเดียว", () => {
  const r = run(`import {emit} from ${JSON.stringify(outUrl)}; emit({a:1})`);
  assert.equal(r.stdout, '{"ok":true,"a":1}\n');
});
void VfError;
