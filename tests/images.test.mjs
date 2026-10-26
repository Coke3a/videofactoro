import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cf from "../tools/cf.mjs";
import { readCosts } from "../tools/cost.mjs";
import { libLoad } from "../tools/cache.mjs";
import { generateImage } from "../tools/images.mjs";

const TINY = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
const B64 = fs.readFileSync(TINY).toString("base64");
const ENV = { CLOUDFLARE_AI_ACCOUNT_ID: "acc1", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456", VF_R2_BUCKET: "bkt", VF_R2_ACCESS_KEY_ID: "AKID", VF_R2_SECRET_ACCESS_KEY: "SECRETSECRET" };

let calls, dir, origWrite, saved;
const aiCalls = () => calls.filter((c) => c.url.includes("/ai/run"));
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  delete process.env.VF_R2_TOKEN;
  calls = [];
  cf.setSleep(async () => {});
  cf.setFetch(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", init });
    if (String(url).includes("r2.cloudflarestorage.com")) return new Response(null, { status: init.method === "HEAD" ? 404 : 200 });
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, result: { image: B64 } }) };
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-img-"));
  origWrite = process.stderr.write;
  process.stderr.write = () => true;
});
afterEach(() => {
  process.stderr.write = origWrite;
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  cf.setFetch((...a) => globalThis.fetch(...a));
  fs.rmSync(dir, { recursive: true, force: true });
});

const base = () => ({ projectDir: dir, prompt: "a red fox", kind: "keyframe", need: "n1", seed: 7 });

test("เรียกซ้ำด้วยค่าเดิมไม่ยิงโมเดลรอบสอง และ cached true", async () => {
  const a = await generateImage(base());
  assert.equal(a.cached, false);
  assert.ok(fs.existsSync(a.file) && path.isAbsolute(a.file));
  assert.equal(a.entry.file, a.entry.blob);
  assert.match(a.entry.id, /^keyframe-[0-9a-f]{12}$/);
  const n = aiCalls().length;
  const b = await generateImage(base());
  assert.equal(b.cached, true);
  assert.equal(b.usd, 0);
  assert.equal(aiCalls().length, n);
  assert.equal(libLoad(dir).entries.length, 1);
  const rows = readCosts(path.join(dir, ".vf"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].outcome, "ok");
  assert.equal(rows[0].units.mp, 0.54);
  assert.equal(rows[1].outcome, "cached");
  assert.equal(rows[1].cached, true);
});

test("ไม่ระบุ seed: สุ่มตอน miss แล้วเรียกซ้ำยัง hit cache", async () => {
  const p = { ...base() };
  delete p.seed;
  const a = await generateImage(p);
  assert.ok(Number.isInteger(a.entry.seed) && a.entry.seed >= 0 && a.entry.seed < 2 ** 32);
  assert.equal((await generateImage(p)).cached, true);
});

test("ส่ง refs เป็น https URL จาก uploadTemp", async () => {
  const a = await generateImage({ ...base(), refs: [TINY] });
  const body = JSON.parse(aiCalls()[0].init.body);
  assert.equal(body.input.images.length, 1);
  assert.match(body.input.images[0], /^https:\/\/.*X-Amz-Signature=/);
  assert.deepEqual(a.entry.refs, [TINY]);
  assert.ok(!JSON.stringify(a.entry).includes("X-Amz"));
  assert.equal(body.input.aspect_ratio, "9:16");
  assert.equal(body.input.resolution, "1k");
});

test("ไม่มี refs: ไม่ใส่ images", async () => {
  await generateImage(base());
  assert.ok(!("images" in JSON.parse(aiCalls()[0].init.body).input));
});

test("prompt ต่อท้ายด้วย No text", async () => {
  const a = await generateImage(base());
  assert.equal(JSON.parse(aiCalls()[0].init.body).input.prompt, "a red fox No text, no letters, no logos, no watermark.");
  assert.equal(a.entry.prompt, "a red fox");
});

test("refs 5 ภาพถูกปฏิเสธก่อนยิงเครือข่าย", async () => {
  await assert.rejects(generateImage({ ...base(), refs: Array(5).fill(TINY) }), (e) => e.code === "INTERNAL");
  assert.equal(calls.length, 0);
});

test("ไม่ระบุ kind → USAGE", async () => {
  const p = base();
  delete p.kind;
  await assert.rejects(generateImage(p), (e) => e.code === "USAGE");
});

test("run ล้มเหลว: log cost error แล้ว rethrow", async () => {
  cf.setFetch(async () => ({ ok: false, status: 400, text: async () => "bad" }));
  await assert.rejects(generateImage(base()));
  const rows = readCosts(path.join(dir, ".vf"));
  assert.equal(rows[0].outcome, "error");
  assert.equal(rows[0].usd, null);
});
