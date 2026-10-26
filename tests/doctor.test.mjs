import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = new URL("../bin/vf.mjs", import.meta.url).pathname;

function vf(envOverrides, ...args) {
  const cwd = mkdtempSync(join(tmpdir(), "vf-doctor-"));
  try {
    const env = { PATH: process.env.PATH, HOME: cwd, VF_NO_DOTENV: "1", ...envOverrides };
    return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd, env });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const SECRETS = {
  CLOUDFLARE_AI_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CLOUDFLARE_AI_API_TOKEN: "tok_SECRET_VALUE_aaaaaaaaaaaaaaaa",
  VF_R2_BUCKET: "bucket-secret-name",
  VF_R2_TOKEN: "r2tok_SECRET_VALUE_bbbbbbbbbbbbbbbb",
};

test("doctor ไม่พิมพ์ค่าคีย์", () => {
  const r = vf(SECRETS, "doctor");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const v of Object.values(SECRETS)) {
    assert.ok(!r.stdout.includes(v), "stdout leaked a value");
    assert.ok(!r.stderr.includes(v), "stderr leaked a value");
    assert.ok(!r.stdout.includes(v.slice(0, 10)), "prefix leaked");
  }
  assert.ok(r.stdout.includes("ยาว"));
  const j = JSON.parse(r.stdout);
  const names = j.checks.map((c) => c.name);
  for (const n of ["node>=22", "ffmpeg", "ffprobe", "env:CLOUDFLARE_AI_API_TOKEN", "env:VF_R2_TOKEN"]) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(!names.includes("cf:token"), "offline doctor must not do network checks");
  const t = j.checks.find((c) => c.name === "env:CLOUDFLARE_AI_API_TOKEN");
  assert.equal(t.ok, true);
  assert.equal(t.detail, `ตั้งแล้ว ยาว ${SECRETS.CLOUDFLARE_AI_API_TOKEN.length}`);
});

test("doctor exit 3 เมื่อ env หลักขาด และยังมี checks ใน details", () => {
  const r = vf({ CLOUDFLARE_AI_ACCOUNT_ID: SECRETS.CLOUDFLARE_AI_ACCOUNT_ID }, "doctor");
  assert.equal(r.status, 3, r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.error.code, "CONFIG");
  const checks = j.error.details.checks;
  assert.ok(Array.isArray(checks) && checks.length >= 5);
  const miss = checks.find((c) => c.name === "env:CLOUDFLARE_AI_API_TOKEN");
  assert.equal(miss.ok, false);
  assert.equal(miss.detail, "ยังไม่ตั้ง");
  assert.ok(!r.stdout.includes(SECRETS.CLOUDFLARE_AI_ACCOUNT_ID));
});

test("doctor ไม่มี R2 เลยก็ผ่าน (R2 ใช้แค่ตอนทำวิดีโอ)", () => {
  const r = vf({ CLOUDFLARE_AI_ACCOUNT_ID: SECRETS.CLOUDFLARE_AI_ACCOUNT_ID, CLOUDFLARE_AI_API_TOKEN: SECRETS.CLOUDFLARE_AI_API_TOKEN }, "doctor");
  assert.equal(r.status, 0, r.stdout);
  const cred = JSON.parse(r.stdout).checks.find((c) => c.name === "env:R2_CREDENTIAL");
  assert.equal(cred.ok, true);
  assert.match(cred.detail, /วิดีโอ/);
});

test("doctor รับ access key pair แทน VF_R2_TOKEN", () => {
  const { VF_R2_TOKEN, ...rest } = SECRETS;
  const r = vf({ ...rest, VF_R2_ACCESS_KEY_ID: "AKIDEXAMPLE0000000000", VF_R2_SECRET_ACCESS_KEY: "secretsecretsecretsecret00" }, "doctor");
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!r.stdout.includes("secretsecretsecretsecret00"));
});

test("doctor ออฟไลน์ไม่เรียกเครือข่ายเลย (fetch ที่ throw ไม่ถูกเรียก)", async () => {
  const { setFetch } = await import("../tools/cf.mjs");
  const { main } = await import("../tools/doctor.mjs");
  const keys = Object.keys(SECRETS);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, SECRETS);
  let calls = 0;
  setFetch(() => { calls++; throw new Error("network used"); });
  try {
    const { checks } = await main([]);
    assert.ok(checks.length >= 5);
    assert.equal(calls, 0);
  } finally {
    setFetch((...a) => globalThis.fetch(...a));
    for (const k of keys) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
});
