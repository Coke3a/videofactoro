import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cf from "../tools/cf.mjs";
import { VfError } from "../tools/out.mjs";

const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const TOKEN = "tok-secret-123456";
let calls, sleeps, clock;
const reply = (body, status = 200) => ({ ok: status < 400, status, text: async () => body, arrayBuffer: async () => Buffer.from(body) });
function fake(...replies) {
  calls = [];
  cf.setFetch(async (url, init) => { calls.push({ url, init }); const r = replies.length > 1 ? replies.shift() : replies[0]; return typeof r === "function" ? r() : r; });
}
beforeEach(() => {
  process.env.CLOUDFLARE_AI_ACCOUNT_ID = "acc1";
  process.env.CLOUDFLARE_AI_API_TOKEN = TOKEN;
  delete process.env.VF_AIG_GATEWAY_ID;
  sleeps = [];
  clock = 0;
  cf.setNow(() => clock);
  cf.setSleep(async (ms) => { sleeps.push(ms); clock += ms; });
});
afterEach(() => { for (const k of ["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "VF_AIG_GATEWAY_ID"]) delete process.env[k]; });

test("run โมเดลภายนอกยิง /ai/run พร้อม {model,input}", async () => {
  fake(reply(fx("cf-completed.json")));
  const { result } = await cf.run("black-forest-labs/flux-3-image-klein", { prompt: "x" }, { meta: { project: "p" } });
  assert.ok(calls[0].url.endsWith("/accounts/acc1/ai/run"));
  const b = JSON.parse(calls[0].init.body);
  assert.equal(b.model, "black-forest-labs/flux-3-image-klein");
  assert.deepEqual(b.input, { prompt: "x" });
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers["cf-aig-metadata"], '{"project":"p"}');
  assert.equal(calls[0].init.headers["cf-aig-max-attempts"], undefined);
  assert.equal(result.video, "https://cdn.example/v.mp4");
});

test("ไม่มีการส่ง cf-aig-max-attempts และส่ง gateway id เมื่อตั้งค่า", async () => {
  process.env.VF_AIG_GATEWAY_ID = "gw";
  fake(reply(fx("cf-completed.json")));
  await cf.run("a/b", {});
  const keys = Object.keys(calls[0].init.headers).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("cf-aig-max-attempts"));
  assert.equal(calls[0].init.headers["cf-aig-gateway-id"], "gw");
});

test("run โมเดล @cf ยิง /ai/run/@cf/... body = input ตรงๆ", async () => {
  fake(reply('{"success":true,"result":{"response":"ok"}}'));
  await cf.run("@cf/cloudflare/clef-omni", { prompt: "q" });
  assert.ok(calls[0].url.endsWith("/ai/run/@cf/cloudflare/clef-omni"));
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: "q" });
});

test("multipart สร้าง FormData", async () => {
  fake(reply('{"success":true,"result":{"image":"AAA"}}'));
  await cf.run("bria/remove-background", { image: Buffer.from("abc"), mode: "x" }, { multipart: true });
  const fd = calls[0].init.body;
  assert.ok(fd instanceof FormData);
  assert.equal(fd.get("model"), "bria/remove-background");
  assert.equal(fd.get("mode"), "x");
  assert.ok(fd.get("image") instanceof Blob);
  assert.equal(calls[0].init.headers["Content-Type"], undefined);
});

test("HTTP 200 ที่ state Failed ถือว่าล้ม", async () => {
  fake(reply(fx("cf-failed.json")));
  await assert.rejects(cf.run("a/b", {}), (e) => e.status === 200 && /Failed/.test(e.body));
});

test("HTTP 200 success:false ถือว่าล้ม", async () => {
  fake(reply('{"success":false,"errors":[{"message":"boom"}]}'));
  await assert.rejects(cf.run("a/b", {}));
});

test("queued + request_id → pollRequest จนเสร็จ", async () => {
  fake(reply(fx("cf-queued.json")), reply(fx("cf-running.json")), reply(fx("cf-completed.json")));
  const { result } = await cf.run("black-forest-labs/flux-3-video", {});
  assert.equal(calls.length, 3);
  assert.ok(calls[1].url.endsWith("/accounts/acc1/ai/requests/req-1"));
  assert.equal(calls[1].init.method, "GET");
  assert.equal(result.video, "https://cdn.example/v.mp4");
  assert.deepEqual(sleeps, [5000]);
});

test("poll หมดเวลา → TIMEOUT", async () => {
  fake(reply(fx("cf-running.json")));
  await assert.rejects(cf.pollRequest("req-1", { intervalMs: 10, timeoutMs: 30 }), (e) => e.details.kind === "TIMEOUT" && e.details.request_id === "req-1");
});

test("503 ระหว่าง poll แล้ว Completed → สำเร็จ ส่งงานครั้งเดียว", async () => {
  fake(reply(fx("cf-queued.json")), reply("down", 503), reply(fx("cf-completed.json")));
  const { result } = await cf.withRetry(() => cf.run("black-forest-labs/flux-3-video", {}));
  assert.equal(result.video, "https://cdn.example/v.mp4");
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1);
});

test("poll เกินเวลา → error มี request_id และ withRetry ไม่ส่งงานซ้ำ", async () => {
  fake(reply(fx("cf-queued.json")), reply(fx("cf-running.json")));
  await assert.rejects(
    cf.withRetry(() => cf.run("black-forest-labs/flux-3-video", {}, { pollTimeoutMs: 20_000 })),
    (e) => e instanceof VfError && e.code === "PROVIDER" && e.details.request_id === "req-1" && e.details.kind === "TIMEOUT",
  );
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1);
});

test("classify", () => {
  const c = (status, body = "") => cf.classify({ status, body });
  assert.equal(c(500, "Request timed out"), "TIMEOUT");
  assert.equal(c(422, "moderation"), "CONTENT_BLOCKED");
  assert.equal(c(422, "Content moderation error"), "CONTENT_BLOCKED");
  assert.equal(c(400, "...safety..."), "CONTENT_BLOCKED");
  assert.equal(c(401), "CONFIG_ERROR");
  assert.equal(c(403), "CONFIG_ERROR");
  assert.equal(c(429), "PROVIDER_BUSY");
  assert.equal(c(503), "PROVIDER_DOWN");
  assert.equal(c(400, "Bad input"), "BAD_INPUT");
});

const timeoutErr = () => Object.assign(new Error("Request timed out"), { status: 500, body: "Request timed out" });

test("withRetry ลอง TIMEOUT 3 ครั้งรวม แล้วยอม", async () => {
  let n = 0;
  await assert.rejects(cf.withRetry(async () => { n++; throw timeoutErr(); }), (e) => e instanceof VfError && e.code === "PROVIDER" && e.details.kind === "TIMEOUT");
  assert.equal(n, 3);
});

test("withRetry BUSY/DOWN หน่วง 10/20/30 วิ", async () => {
  let n = 0;
  await assert.rejects(cf.withRetry(async () => { n++; throw Object.assign(new Error("x"), { status: 503, body: "" }); }), (e) => e.code === "PROVIDER" && e.details.kind === "PROVIDER_DOWN");
  assert.equal(n, 4);
  assert.deepEqual(sleeps, [10000, 20000, 30000]);
});

test("withRetry ไม่ลอง CONTENT_BLOCKED ซ้ำ", async () => {
  let n = 0;
  await assert.rejects(cf.withRetry(async () => { n++; throw Object.assign(new Error("m"), { status: 422, body: "Content moderation error" }); }), (e) => e.code === "BLOCKED");
  assert.equal(n, 1);
});

test("withRetry: CONFIG และ BAD_INPUT ไม่ลองซ้ำ", async () => {
  let n = 0;
  await assert.rejects(cf.withRetry(async () => { n++; throw Object.assign(new Error("m"), { status: 401, body: "" }); }), (e) => e.code === "CONFIG");
  await assert.rejects(cf.withRetry(async () => { n++; throw Object.assign(new Error("m"), { status: 400, body: "Bad input" }); }), (e) => e.code === "PROVIDER" && e.details.kind === "BAD_INPUT");
  assert.equal(n, 2);
});

test("withRetry สำเร็จหลังล้มครั้งแรก", async () => {
  let n = 0;
  assert.equal(await cf.withRetry(async () => { if (n++ === 0) throw timeoutErr(); return "ok"; }), "ok");
});

test("token ไม่รั่วใน error", async () => {
  fake(reply(`oops ${TOKEN}`, 500));
  await assert.rejects(cf.run("a/b", {}), (e) => !e.message.includes(TOKEN) && !e.body.includes(TOKEN));
});

test("ไม่มี env → CONFIG", async () => {
  delete process.env.CLOUDFLARE_AI_API_TOKEN;
  await assert.rejects(cf.run("a/b", {}), (e) => e.code === "CONFIG");
});

test("extractMedia", () => {
  assert.deepEqual(cf.extractMedia({ result: { image: "https://x" } }), { kind: "url", value: "https://x", field: "image" });
  assert.deepEqual(cf.extractMedia({ image: "data:image/png;base64,AAA" }), { kind: "base64", value: "AAA", field: "image" });
  assert.throws(() => cf.extractMedia({}), (e) => e.code === "PROVIDER");
});

test("download base64 และ url", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-"));
  try {
    const a = await cf.download({ kind: "base64", value: Buffer.from("hi").toString("base64") }, path.join(dir, "s/a.bin"));
    assert.equal(fs.readFileSync(a, "utf8"), "hi");
    fake(reply("data"));
    const b = await cf.download("https://x/y", path.join(dir, "b.bin"));
    assert.equal(fs.readFileSync(b, "utf8"), "data");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("onRequestId ถูกเรียกแบบ sync ทันทีที่รู้ id ก่อน poll ครั้งแรก", async () => {
  const seen = [];
  fake(reply(fx("cf-queued.json")), () => { seen.push(`poll:${calls.length}`); return reply(fx("cf-completed.json")); });
  const { result } = await cf.run("black-forest-labs/flux-3-video", {}, { onRequestId: (id) => seen.push(`id:${id}:${calls.length}`) });
  assert.deepEqual(seen, ["id:req-1:1", "poll:2"]);
  assert.equal(result.video, "https://cdn.example/v.mp4");
});

test("resumeRequestId ข้าม POST แล้ว poll id เดิมตรงๆ ผ่าน result handling เดียวกัน", async () => {
  fake(reply('{"success":true,"result":{"state":"Running"}}'), reply(fx("cf-completed.json")));
  const ids = [];
  const { result } = await cf.run("black-forest-labs/flux-3-video", { prompt: "x" }, { resumeRequestId: "req-9", onRequestId: (id) => ids.push(id) });
  assert.ok(calls.every((c) => c.init.method === "GET"));
  assert.ok(calls[0].url.endsWith("/ai/requests/req-9"));
  assert.equal(result.video, "https://cdn.example/v.mp4");
  assert.deepEqual(ids, []);
  fake(reply('{"success":true,"result":{"state":"Failed","error":"x"}}'));
  await assert.rejects(cf.run("black-forest-labs/flux-3-video", {}, { resumeRequestId: "req-9" }), (e) => e instanceof VfError && e.details.request_id === "req-9");
});

test("queued แต่ไม่มี id → VfError PROVIDER NO_REQUEST_ID และ withRetry ไม่ส่งงานซ้ำ", async () => {
  fake(reply('{"success":true,"result":{"state":"Queued"}}'));
  await assert.rejects(cf.withRetry(() => cf.run("black-forest-labs/flux-3-video", {})), (e) => {
    assert.ok(e instanceof VfError);
    assert.equal(e.code, "PROVIDER");
    assert.equal(e.details.kind, "NO_REQUEST_ID");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("onRequestId throw → VfError มี request_id (ไม่ใช่ Error ธรรมดาที่ withRetry จะส่งซ้ำ)", async () => {
  fake(reply(fx("cf-queued.json")));
  await assert.rejects(cf.withRetry(() => cf.run("a/b", {}, { onRequestId: () => { throw new Error("disk full"); } })),
    (e) => e instanceof VfError && e.details.request_id === "req-1");
  assert.equal(calls.length, 1);
});
