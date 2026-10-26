import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as cf from "../tools/cf.mjs";
import { VfError } from "../tools/out.mjs";
import { readCosts } from "../tools/cost.mjs";
import { RULES } from "../tools/qa-rules.mjs";
import { toQaImage, clef, pickBest, generateWithQa } from "../tools/qa.mjs";

const TINY = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
const reply = (body, status = 200) => ({ ok: status < 400, status, text: async () => body });
const ok = (answers, usage = { prompt_tokens: 1000 }) => reply(JSON.stringify({ success: true, result: { answers, usage } }));
const n = (v) => ({ noul: v });
const place = (fits, text = 0, pa = 0) => ({ fits: n(fits), has_text: n(text), has_people_or_animals: n(pa) });

let calls, dir, origWrite;
function fake(...replies) {
  calls = [];
  cf.setFetch(async (url, init) => { calls.push({ url, init }); return replies.length > 1 ? replies.shift() : replies[0]; });
}
const bodyOf = (i) => JSON.parse(calls[i].init.body);

beforeEach(() => {
  process.env.CLOUDFLARE_AI_ACCOUNT_ID = "acc1";
  process.env.CLOUDFLARE_AI_API_TOKEN = "tok-secret-123456";
  cf.setSleep(async () => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-qa-"));
  origWrite = process.stderr.write;
  process.stderr.write = () => true;
});
afterEach(() => {
  process.stderr.write = origWrite;
  for (const k of ["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN"]) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

test("toQaImage คืน data URI ของ JPEG กว้าง 640", async () => {
  const uri = await toQaImage(TINY);
  assert.ok(uri.startsWith("data:image/jpeg;base64,"));
  const f = path.join(dir, "o.jpg");
  fs.writeFileSync(f, Buffer.from(uri.split(",")[1], "base64"));
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", f]).toString().trim();
  assert.equal(out, "640,426");
});

test("clef body ใช้ model clef-omni และ images เป็น data URI", async () => {
  fake(ok({ a: n(0.9) }));
  const images = [await toQaImage(TINY)];
  const answers = await clef({ state: { x: 1 }, questions: { a: { type: "noul", instructions: "q" } }, images, videos: ["v1"], audio: ["a1"], meta: { step: "qa" }, costDir: dir });
  assert.deepEqual(answers, { a: n(0.9) });
  assert.match(calls[0].url, /\/ai\/run\/@cf\/cloudflare\/clef-omni$/);
  const b = bodyOf(0);
  assert.equal(b.model, "clef-omni");
  assert.equal(typeof b.state, "string");
  assert.ok(b.images[0].startsWith("data:image/jpeg;base64,"));
  assert.equal(b.state, '{"x":1}');
  assert.deepEqual(b.videos, ["v1"]);
  assert.deepEqual(b.audio, ["a1"]);
  assert.equal(b.questions.a.instructions, "q");
  const rows = readCosts(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "ok");
  assert.equal(rows[0].step, "qa");
  assert.equal(rows[0].units.tokensIn, 1000);
  assert.ok(Math.abs(rows[0].usd - 0.00015) < 1e-9);
});

test("clef ไม่ส่ง videos/audio เมื่อไม่ได้ให้", async () => {
  fake(ok({}));
  await clef({ state: "s", questions: {}, meta: {}, costDir: dir });
  assert.equal("videos" in bodyOf(0), false);
  assert.equal("audio" in bodyOf(0), false);
});

test("clef ไม่มี costDir -> INTERNAL ก่อนเรียกเครือข่าย", async () => {
  fake(ok({}));
  await assert.rejects(clef({ state: "s", questions: {}, meta: {} }), (e) => e.code === "INTERNAL");
  assert.equal(calls.length, 0);
});

test("clef จำกัดจำนวน images/videos/audio", async () => {
  fake(ok({}));
  const run = (extra) => clef({ state: "s", questions: {}, meta: {}, costDir: dir, ...extra });
  await assert.rejects(run({ images: ["a", "b", "c", "d", "e"] }), (e) => e instanceof VfError && e.code === "INTERNAL");
  await assert.rejects(run({ videos: ["a", "b", "c"] }), (e) => e.code === "INTERNAL");
  await assert.rejects(run({ audio: ["a", "b", "c", "d", "e"] }), (e) => e.code === "INTERNAL");
  assert.equal(calls.length, 0);
});

test("clef ไม่มี answers ใน result -> PROVIDER", async () => {
  fake(reply(JSON.stringify({ success: true, result: { usage: { prompt_tokens: 5 } } })));
  await assert.rejects(clef({ state: "s", questions: {}, meta: { step: "qa" }, costDir: dir }), (e) => e.code === "PROVIDER" && e.message === "clef-omni ไม่คืน answers");
});

test("clef error -> log outcome error แล้ว throw ต่อ", async () => {
  fake(reply("not found", 404));
  await assert.rejects(clef({ state: "s", questions: {}, meta: { step: "qa" }, costDir: dir }), (e) => e.code === "CONFIG");
  const rows = readCosts(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "error");
  assert.equal(rows[0].usd, null);
});

test("characterRef.judge ไม่ผ่านเมื่อ has_text 0.6", () => {
  const v = RULES.characterRef.judge({ matches_look: n(0.9), single_character: n(0.9), has_text: n(0.6), full_body: n(1) });
  assert.equal(v.pass, false);
  assert.equal(v.reasons.length, 1);
  assert.ok(Math.abs(v.score - (0.9 + 0.2 - 0.6)) < 1e-9);
});

test("characterRef.judge ผ่าน และคำตอบที่หายไปไม่มีทางผ่าน", () => {
  const good = RULES.characterRef.judge({ matches_look: n(0.8), single_character: n(0.8), has_text: n(0.1), full_body: n(0.5) });
  assert.equal(good.pass, true);
  assert.deepEqual(good.reasons, []);
  const missing = RULES.characterRef.judge({});
  assert.equal(missing.pass, false);
  assert.equal(RULES.placePlate.judge({}).pass, false);
});

test("placePlate.judge score และเกณฑ์", () => {
  const v = RULES.placePlate.judge(place(0.8, 0.1, 0.2));
  assert.equal(v.pass, true);
  assert.ok(Math.abs(v.score - (0.8 - 0.1 - 0.1)) < 1e-9);
  assert.equal(RULES.placePlate.judge(place(0.8, 0.1, 0.6)).pass, false);
  assert.equal(RULES.placePlate.judge(place(0.4)).pass, false);
});

test("RULES.questions ใส่ ctx ลงในคำถาม", () => {
  assert.match(RULES.characterRef.questions({ look: "red fox", style: "anime" }).matches_look.instructions, /red fox/);
  assert.match(RULES.placePlate.questions({ desc: "old kitchen", style: "anime" }).fits.instructions, /old kitchen.*anime/);
});

const files = () => [{ file: TINY, id: "a" }, { file: TINY, id: "b" }, { file: TINY, id: "c" }];
const ctx = { desc: "kitchen", style: "anime" };

test("pickBest เลือกภาพที่ score สูงสุดในกลุ่มที่ผ่าน", async () => {
  fake(ok(place(0.6)), ok(place(0.9, 0.5)), ok(place(0.8)));
  const cands = files();
  const r = await pickBest(cands, RULES.placePlate, ctx, { meta: { step: "qa" }, costDir: dir });
  assert.equal(r.best.id, "c");
  assert.deepEqual(r.ranked.map((x) => x.candidate.id), ["c", "a", "b"]);
  assert.equal(r.ranked[0].verdict.pass, true);
  assert.equal(r.ranked[2].verdict.pass, false);
  assert.equal(r.best.warning, undefined);
  assert.equal("verdict" in cands[0], false);
  assert.equal("verdict" in r.best, false);
  assert.equal(calls.length, 3);
  assert.equal(bodyOf(0).images.length, 1);
  assert.equal(readCosts(dir).length, 3);
});

test("pickBest ไม่มีภาพผ่าน คืนภาพคะแนนสูงสุดพร้อม warning", async () => {
  fake(ok(place(0.3)), ok(place(0.45)), ok(place(0.2)));
  const cands = files();
  const r = await pickBest(cands, RULES.placePlate, ctx, { meta: { step: "qa" }, costDir: dir });
  assert.equal(r.best.id, "b");
  assert.equal(r.best.warning, "ไม่มีภาพผ่านเกณฑ์ QA — ใช้ภาพคะแนนสูงสุด");
  assert.equal(r.ranked[0].candidate.warning, undefined);
  assert.equal("warning" in cands[1], false);
});

test("pickBest ส่ง state และ look ใน body; default state เมื่อ rule ไม่มี", async () => {
  fake(ok({ matches_look: n(1) }), ok({ x: n(1) }));
  await pickBest([files()[0]], RULES.characterRef, { look: "red fox", style: "anime" }, { meta: {}, costDir: dir });
  assert.match(bodyOf(0).state, /anime/);
  assert.match(bodyOf(0).questions.matches_look.instructions, /red fox/);
  const rule = { questions: () => ({ x: { type: "noul", instructions: "q" } }), judge: () => V(true, 1) };
  await pickBest([files()[0]], rule, {}, { meta: {}, costDir: dir });
  assert.equal(bodyOf(1).state, "An image to check.");
});

test("pickBest ข้ามภาพที่ provider error แล้วทำต่อ", async () => {
  fake(ok(place(0.6)), reply("boom", 500), reply("boom", 500), reply("boom", 500), reply("boom", 500), ok(place(0.8)));
  const r = await pickBest(files(), RULES.placePlate, ctx, { meta: {}, costDir: dir });
  assert.equal(r.best.id, "c");
  const bad = r.ranked.find((x) => x.candidate.id === "b");
  assert.equal(bad.verdict.pass, false);
  assert.equal(bad.verdict.score, -Infinity);
  assert.deepEqual(bad.verdict.reasons, ["QA error: PROVIDER"]);
});

test("pickBest ทุกภาพ error -> PROVIDER; CONFIG throw ทันที; ไม่มี candidates -> INTERNAL", async () => {
  fake(reply("boom", 500));
  await assert.rejects(pickBest(files(), RULES.placePlate, ctx, { meta: {}, costDir: dir }), (e) => e.code === "PROVIDER");
  fake(reply("not found", 404));
  await assert.rejects(pickBest(files(), RULES.placePlate, ctx, { meta: {}, costDir: dir }), (e) => e.code === "CONFIG");
  assert.equal(calls.length, 1);
  await assert.rejects(pickBest([], RULES.placePlate, ctx, { meta: {}, costDir: dir }), (e) => e.code === "INTERNAL");
});

test("pickBest ไฟล์ภาพเสีย (toQaImage INTERNAL) ถูกข้าม", async () => {
  fake(ok(place(0.8)));
  const r = await pickBest([{ file: path.join(dir, "missing.png"), id: "x" }, files()[0]], RULES.placePlate, ctx, { meta: {}, costDir: dir });
  assert.equal(r.best.id, "a");
  assert.deepEqual(r.ranked[1].verdict.reasons, ["QA error: INTERNAL"]);
});

const V = (pass, score) => ({ pass, score, reasons: [] });

test("generateWithQa หยุดเมื่อผ่าน", async () => {
  const gen = [];
  const r = await generateWithQa({
    generate: async (i) => { gen.push(i); return { i }; },
    check: async (c) => (c.i === 1 ? V(true, 0.9) : V(false, 0.1)),
  });
  assert.deepEqual(gen, [0, 1]);
  assert.equal(r.passed, true);
  assert.equal(r.best.i, 1);
  assert.equal(r.attempts.length, 2);
});

test("generateWithQa สร้างไม่เกิน 1+2 ครั้ง แล้วคืนตัวดีที่สุด passed:false", async () => {
  let count = 0;
  const scores = [0.2, 0.5, 0.3];
  const r = await generateWithQa({
    generate: async (i) => { count++; return { i }; },
    check: async (c) => V(false, scores[c.i]),
  });
  assert.equal(count, 3);
  assert.equal(r.passed, false);
  assert.equal(r.best.i, 1);
  assert.equal(r.verdict.score, 0.5);
  assert.equal(r.attempts.length, 3);
});
