import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { setFetch } from "../tools/cf.mjs";
import { presignUrl, r2Config, uploadTemp, ensureBucket, putLifecycle, putObject, headObject } from "../tools/r2.mjs";

const KEYS = ["CLOUDFLARE_AI_ACCOUNT_ID", "VF_R2_BUCKET", "VF_R2_ACCESS_KEY_ID", "VF_R2_SECRET_ACCESS_KEY", "VF_R2_TOKEN"];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { CLOUDFLARE_AI_ACCOUNT_ID: "acc123", VF_R2_BUCKET: "bkt", VF_R2_ACCESS_KEY_ID: "AKID", VF_R2_SECRET_ACCESS_KEY: "SECRETSECRET" });
  delete process.env.VF_R2_TOKEN;
});
afterEach(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  setFetch((...a) => globalThis.fetch(...a));
});

const recorder = (statusFor) => {
  const calls = [];
  setFetch(async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body });
    return new Response(null, { status: statusFor(init.method ?? "GET", calls.length) });
  });
  return calls;
};

test("presign ตรงกับตัวอย่างของ AWS", () => {
  const url = presignUrl({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    expiresSec: 86400, now: new Date("2013-05-24T00:00:00Z") });
  assert.ok(url.endsWith("&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"));
  assert.ok(url.startsWith("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&"));
});

test("presign: signed headers เรียงตามตัวอักษร", () => {
  const url = presignUrl({ method: "PUT", host: "h.example", path: "/b", region: "auto", accessKeyId: "A", secretAccessKey: "S",
    expiresSec: 60, now: new Date("2026-01-01T00:00:00Z"), headers: { "Content-MD5": "abc==" }, query: { lifecycle: "" } });
  assert.match(url, /X-Amz-SignedHeaders=content-md5%3Bhost/);
  assert.match(url, /[?&]lifecycle=&/);
});

test("r2Config ใช้ access key ตรงๆ", async () => {
  const c = await r2Config();
  assert.deepEqual(c, { accountId: "acc123", bucket: "bkt", host: "acc123.r2.cloudflarestorage.com", accessKeyId: "AKID", secretAccessKey: "SECRETSECRET" });
});

test("r2Config จาก VF_R2_TOKEN: id จาก verify, secret = sha256 ของ token", async () => {
  delete process.env.VF_R2_ACCESS_KEY_ID; delete process.env.VF_R2_SECRET_ACCESS_KEY;
  process.env.VF_R2_TOKEN = "tok-abcdefgh";
  const calls = [];
  setFetch(async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ result: { id: "tokid" } }), { status: 200 }); });
  const c = await r2Config();
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/user/tokens/verify");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok-abcdefgh");
  assert.equal(c.accessKeyId, "tokid");
  assert.equal(c.secretAccessKey, crypto.createHash("sha256").update("tok-abcdefgh").digest("hex"));
});

test("uploadTemp ไม่อัปโหลดซ้ำเมื่อ head เจอ", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2-"));
  const f = path.join(dir, "a.png");
  fs.writeFileSync(f, "hello");
  const calls = recorder(() => 200);
  const url = await uploadTemp(f);
  assert.deepEqual(calls.map((c) => c.method), ["HEAD"]);
  const hash = crypto.createHash("sha256").update("hello").digest("hex");
  assert.ok(url.startsWith(`https://acc123.r2.cloudflarestorage.com/bkt/tmp/${hash}.png?`));
  assert.match(url, /X-Amz-Expires=7200/);
  fs.rmSync(dir, { recursive: true });
});

test("uploadTemp อัปโหลดเมื่อ head ไม่เจอ", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2-"));
  const f = path.join(dir, "a.mp4");
  fs.writeFileSync(f, "x");
  const calls = recorder((m) => (m === "HEAD" ? 404 : 200));
  await uploadTemp(f);
  assert.deepEqual(calls.map((c) => c.method), ["HEAD", "PUT"]);
  assert.match(calls[0].url, /X-Amz-Expires=60&/);
  const put = calls[1];
  assert.deepEqual(Buffer.from(put.body), Buffer.from("x"));
  assert.equal(put.headers["content-type"], "video/mp4");
  assert.match(put.url, /X-Amz-Expires=60&/);
  assert.match(put.url, /X-Amz-SignedHeaders=content-type%3Bhost/);
  fs.rmSync(dir, { recursive: true });
});

test("ensureBucket: exists / created / 403 -> CONFIG", async () => {
  recorder(() => 200);
  assert.equal(await ensureBucket(), "exists");
  const calls = recorder((m) => (m === "HEAD" ? 404 : 200));
  assert.equal(await ensureBucket(), "created");
  assert.deepEqual(calls.map((c) => c.method), ["HEAD", "PUT"]);
  recorder(() => 403);
  await assert.rejects(ensureBucket(), (e) => e.code === "CONFIG");
});

test("putLifecycle ส่ง XML + Content-MD5 ที่เซ็นแล้ว", async () => {
  const calls = recorder(() => 200);
  await putLifecycle({ prefix: "tmp/", days: 1 });
  const c = calls[0];
  assert.equal(c.method, "PUT");
  assert.match(c.url, /[?&]lifecycle=&/);
  assert.match(c.url, /X-Amz-Expires=60&/);
  assert.match(c.url, /SignedHeaders=content-md5%3Bcontent-type%3Bhost/);
  const xml = Buffer.from(c.body).toString();
  assert.match(xml, /<Expiration><Days>1<\/Days><\/Expiration>/);
  assert.equal(c.headers["content-md5"], crypto.createHash("md5").update(c.body).digest("base64"));
});

test("error ไม่มี signature/secret ใน message", async () => {
  setFetch(async () => { throw new Error("boom"); });
  await assert.rejects(putObject("k", Buffer.from("a"), "text/plain"), (e) => !/Signature|SECRETSECRET/.test(e.message));
});

test("headObject/putObject: 403 -> CONFIG, 500 -> PROVIDER, 404 head -> false", async () => {
  recorder(() => 403);
  await assert.rejects(headObject("k"), (e) => e.code === "CONFIG");
  await assert.rejects(putObject("k", Buffer.from("a"), "text/plain"), (e) => e.code === "CONFIG");
  recorder(() => 500);
  await assert.rejects(headObject("k"), (e) => e.code === "PROVIDER");
  await assert.rejects(putObject("k", Buffer.from("a"), "text/plain"), (e) => e.code === "PROVIDER");
  recorder(() => 404);
  assert.equal(await headObject("k"), false);
});

test("putObject 404 NoSuchBucket และ head/put 403 -> CONFIG 'bucket ยังไม่พร้อม — รัน vf setup'; 401/500 เหมือนเดิม", async () => {
  const READY = "bucket ยังไม่พร้อม — รัน vf setup";
  setFetch(async (url, init = {}) => (init.method === "HEAD"
    ? new Response(null, { status: 404 })
    : new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 })));
  await assert.rejects(putObject("k", Buffer.from("a"), "text/plain"), (e) => e.code === "CONFIG" && e.message.includes(READY));
  recorder(() => 403);
  await assert.rejects(headObject("k"), (e) => e.code === "CONFIG" && e.message.includes(READY));
  await assert.rejects(putObject("k", Buffer.from("a"), "text/plain"), (e) => e.code === "CONFIG" && e.message.includes(READY));
  recorder(() => 401);
  await assert.rejects(putObject("k", Buffer.from("a"), "text/plain"), (e) => e.code === "CONFIG" && !e.message.includes(READY));
  setFetch(async () => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }));
  await assert.rejects(putObject("k", Buffer.from("a"), "text/plain"), (e) => e.code === "PROVIDER");
});
