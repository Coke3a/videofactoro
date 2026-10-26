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
  assert.equal(rows[1].outcome, "ok");
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

// --- fix round 1 ---
const URLBODY = "https://bkt.acc1.r2.cloudflarestorage.com/bkt/tmp/x.png?X-Amz-Signature=deadbeef";
const urlFree = (e) => !JSON.stringify({ m: e.message, b: e.body, d: e.details }).includes("X-Amz-Signature");

test("run ล้มเหลวพร้อม presigned URL ใน body: error ไม่มี URL", async () => {
  cf.setFetch(async (url, init = {}) => {
    if (String(url).includes("r2.cloudflarestorage.com")) return new Response(null, { status: init.method === "HEAD" ? 404 : 200 });
    return { ok: false, status: 400, text: async () => `bad image ${URLBODY}` };
  });
  await assert.rejects(generateImage({ ...base(), refs: [TINY] }), (e) => {
    assert.ok(urlFree(e), "URL leaked");
    return true;
  });
});

test("download ล้มเหลว: ลง cost error, ลบ temp dir, ไม่มี URL รั่ว", async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("vf-img-") && n !== path.basename(dir));
  cf.setFetch(async (url, init = {}) => {
    if (String(url).includes("r2.cloudflarestorage.com")) return new Response(null, { status: init.method === "HEAD" ? 404 : 200 });
    if (String(url).includes("/ai/run")) return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, result: { image: "https://cdn.example/a.png" } }) };
    throw Object.assign(new Error(`fetch failed ${URLBODY}`), { body: URLBODY });
  });
  await assert.rejects(generateImage({ ...base(), refs: [TINY] }), (e) => urlFree(e));
  const rows = readCosts(path.join(dir, ".vf"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "error");
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("vf-img-") && n !== path.basename(dir));
  assert.deepEqual(after.sort(), before.sort());
});

test("cache hit แต่ blob หาย: ถือเป็น miss แล้วสร้างใหม่", async () => {
  const a = await generateImage(base());
  fs.rmSync(a.file);
  const n = aiCalls().length;
  const b = await generateImage(base());
  assert.equal(b.cached, false);
  assert.equal(aiCalls().length, n + 1);
  assert.ok(fs.existsSync(b.file));
  assert.equal(libLoad(dir).entries.length, 1);
});

test("seed 0 ถูกส่งเป็น seed:0 และ key ต่างจากไม่มี seed", async () => {
  const z = await generateImage({ ...base(), seed: 0 });
  assert.equal(JSON.parse(aiCalls()[0].init.body).input.seed, 0);
  assert.equal(z.entry.seed, 0);
  const p = base();
  delete p.seed;
  const u = await generateImage(p);
  assert.notEqual(z.entry.key, u.entry.key);
});

// --- final fix (R13) ---
test("แถว cost มี step/item/run จาก meta; cache hit = outcome ok + cached:true", async () => {
  const meta = { project: "p", step: "ref", item: "mochi", run: "r1" };
  await generateImage({ ...base(), meta });
  await generateImage({ ...base(), meta });
  const rows = readCosts(path.join(dir, ".vf"));
  assert.deepEqual(rows.map((r) => [r.step, r.item, r.run, r.outcome, r.cached ?? false]), [["ref", "mochi", "r1", "ok", false], ["ref", "mochi", "r1", "ok", true]]);
  assert.equal(JSON.parse(aiCalls()[0].init.headers["cf-aig-metadata"]).item, "mochi");
});

test("ไม่มี meta: step = image, item = null", async () => {
  await generateImage(base());
  const [r] = readCosts(path.join(dir, ".vf"));
  assert.equal(r.step, "image");
  assert.equal(r.item, null);
});

test("content filter → แถว outcome blocked", async () => {
  cf.setFetch(async () => ({ ok: false, status: 400, text: async () => "flagged by moderation" }));
  await assert.rejects(generateImage(base()), (e) => e.code === "BLOCKED");
  const [r] = readCosts(path.join(dir, ".vf"));
  assert.equal(r.outcome, "blocked");
});

test("run สำเร็จแต่ download ล้ม: แถว error มี usd ประเมินจาก resolution ที่ขอ (จ่ายไปแล้ว)", async () => {
  cf.setFetch(async (url) => {
    if (String(url).includes("/ai/run")) return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, result: { image: "https://cdn.example/a.png" } }) };
    throw new Error("fetch failed");
  });
  await assert.rejects(generateImage({ ...base(), resolution: "2k" }));
  const [r] = readCosts(path.join(dir, ".vf"));
  assert.equal(r.outcome, "error");
  assert.ok(Math.abs(r.usd - (0.009 + 3 * 0.0017)) < 1e-12);
});
