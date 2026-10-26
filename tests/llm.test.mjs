import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cf from "../tools/cf.mjs";
import { VfError } from "../tools/out.mjs";
import { MODELS } from "../tools/models.mjs";
import { readCosts } from "../tools/cost.mjs";
import { buildInput, geminiStrip, anthropicStrip, readText, llmJson } from "../tools/llm.mjs";

const G = MODELS.llm[0];
const A = MODELS.llm[1];
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    n: { type: "integer", enum: [1, 2] },
    list: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", additionalProperties: false, properties: { x: { type: "string" } } } },
  },
};
const args = { system: "sys", messages: [{ role: "user", content: "hi" }], schema: SCHEMA, maxTokens: 100 };

const gem = (text, pin = 10, pout = 5) => JSON.stringify({ success: true, result: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: pin, candidatesTokenCount: pout } } });
const ant = (text, i = 10, o = 5) => JSON.stringify({ success: true, result: { content: [{ type: "text", text }], usage: { input_tokens: i, output_tokens: o } } });
const reply = (body, status = 200) => ({ ok: status < 400, status, text: async () => body });

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-llm-"));
  origWrite = process.stderr.write;
  process.stderr.write = () => true;
});
afterEach(() => {
  process.stderr.write = origWrite;
  for (const k of ["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN"]) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

test("gemini input ไม่มี additionalProperties และ enum ของ integer", () => {
  const input = buildInput(G, args);
  const s = JSON.stringify(input);
  assert.ok(!s.includes("additionalProperties"));
  assert.equal(input.generationConfig.responseMimeType, "application/json");
  assert.equal(input.generationConfig.maxOutputTokens, 100);
  assert.equal(input.generationConfig.responseSchema.properties.n.enum, undefined);
  assert.equal(input.generationConfig.responseSchema.properties.list.minItems, 1);
  assert.deepEqual(input.systemInstruction, { parts: [{ text: "sys" }] });
  assert.deepEqual(input.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
});

test("anthropic input ไม่มี minItems และไม่มี temperature", () => {
  const input = buildInput(A, args);
  const s = JSON.stringify(input);
  assert.ok(!s.includes("minItems") && !s.includes("maxItems"));
  assert.ok(!("temperature" in input) && !("top_p" in input));
  assert.equal(input.max_tokens, 100);
  assert.equal(input.system, "sys");
  assert.equal(input.output_config.format.type, "json_schema");
  assert.equal(input.output_config.format.schema.properties.n.enum.length, 2);
  assert.equal(input.output_config.format.schema.additionalProperties, false);
});

test("ภาพ data URI ใส่ใน user ข้อความแรก", () => {
  const img = "data:image/png;base64,QUJD";
  const g = buildInput(G, { ...args, images: [img] });
  assert.deepEqual(g.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: "QUJD" } });
  const a = buildInput(A, { ...args, images: [img] });
  assert.deepEqual(a.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
  assert.deepEqual(a.messages[0].content[1], { type: "text", text: "hi" });
});

test("strip ไม่แก้ schema ต้นฉบับ และ readText อ่านทั้งสองตระกูล", () => {
  geminiStrip(SCHEMA); anthropicStrip(SCHEMA);
  assert.equal(SCHEMA.additionalProperties, false);
  assert.equal(SCHEMA.properties.list.minItems, 1);
  const g = readText(G, JSON.parse(gem("ab", 7, 3)).result);
  assert.deepEqual(g, { text: "ab", usage: { in: 7, out: 3 } });
  const a = readText(A, JSON.parse(ant("cd", 8, 4)).result);
  assert.deepEqual(a, { text: "cd", usage: { in: 8, out: 4 } });
  assert.deepEqual(readText(G, null), { text: "", usage: { in: null, out: null } });
});

test("llmJson ส่ง issues กลับไปรอบสอง", async () => {
  fake(reply(gem('{"a":1}')), reply(gem('{"a":1,"b":2}')));
  const r = await llmJson({ system: "s", user: "u", schema: SCHEMA, validate: (o) => (o.b ? [] : ["ขาด b"]), meta: { step: "bible" }, costDir: dir });
  assert.deepEqual(r.data, { a: 1, b: 2 });
  assert.equal(r.model, G);
  assert.equal(calls.length, 2);
  const second = bodyOf(1).input.contents;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, "model");
  assert.equal(second[1].parts[0].text, '{"a":1}');
  assert.match(second[2].parts[0].text, /^แก้ปัญหาเหล่านี้แล้วตอบ JSON ใหม่ทั้งก้อน:\n- ขาด b/);
});

test("llmJson ข้ามไปโมเดลสำรองเมื่อโมเดลแรกผ่านไม่ได้ 2 รอบ", async () => {
  fake(reply(gem('{"a":1}')), reply(gem('{"a":1}')), reply(ant('{"a":1,"b":2}')));
  const r = await llmJson({ system: "s", user: "u", schema: SCHEMA, validate: (o) => (o.b ? [] : ["ขาด b"]), meta: { step: "bible" }, costDir: dir });
  assert.equal(calls.length, 3);
  assert.equal(bodyOf(2).model, "anthropic/claude-haiku-5.5");
  assert.equal(bodyOf(2).input.messages.length, 1);
  assert.equal(r.model, A);
});

test("parse ไม่ได้นับเป็น issue และตัด fence ได้", async () => {
  fake(reply(gem("ไม่ใช่ json")), reply(gem('```json\n{"b":2}\n```')));
  const r = await llmJson({ system: "s", user: "u", schema: SCHEMA, meta: { step: "x" }, costDir: dir });
  assert.deepEqual(r.data, { b: 2 });
  assert.match(bodyOf(1).input.contents[2].parts[0].text, /ตอบไม่ใช่ JSON ที่ parse ได้/);
});

test("ครบทุกโมเดลแล้วไม่ผ่าน -> PROVIDER พร้อม issues", async () => {
  fake(reply(gem("{}")), reply(gem("{}")), reply(ant("{}")), reply(ant("{}")));
  await assert.rejects(
    llmJson({ system: "s", user: "u", schema: SCHEMA, validate: () => ["ขาด b"], meta: { step: "x" }, costDir: dir }),
    (e) => e instanceof VfError && e.code === "PROVIDER" && e.message === "LLM ตอบไม่ผ่าน validator" && e.details.issues.length === 4,
  );
  assert.equal(calls.length, 4);
});

test("PROVIDER ที่โมเดลแรกข้ามไปโมเดลสำรอง แต่ BLOCKED โยนทันที", async () => {
  fake(reply('{"success":false,"errors":[{"message":"bad input"}]}', 400), reply(ant('{"b":2}')));
  const r = await llmJson({ system: "s", user: "u", schema: SCHEMA, meta: { step: "x" }, costDir: dir });
  assert.equal(r.model, A);
  assert.equal(calls.length, 2);
  fake(reply('{"success":false,"errors":[{"message":"content moderation"}]}', 400));
  await assert.rejects(
    llmJson({ system: "s", user: "u", schema: SCHEMA, meta: { step: "x" }, costDir: dir }),
    (e) => e.code === "BLOCKED",
  );
  assert.equal(calls.length, 1);
});

test("llmJson บันทึก cost ทุก request", async () => {
  fake(reply(gem('{"a":1}', 1000, 500)), reply(gem('{"a":1,"b":2}', 2000, 100)));
  await llmJson({ system: "s", user: "u", schema: SCHEMA, validate: (o) => (o.b ? [] : ["ขาด b"]), meta: { project: "p", step: "bible" }, costDir: dir });
  const rows = readCosts(dir);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.outcome), ["invalid", "ok"]);
  assert.equal(rows[0].step, "bible");
  assert.equal(rows[0].model, G);
  assert.deepEqual(rows[0].units, { tokensIn: 1000, tokensOut: 500 });
  assert.ok(Math.abs(rows[0].usd - (1000 * 0.75 + 500 * 3.75) / 1e6) < 1e-12);
  assert.equal(bodyOf(0).input.contents[0].parts[0].text, "u");
  assert.equal(calls[0].init.headers["cf-aig-metadata"], '{"project":"p","step":"bible"}');
});

test("request ที่ error บันทึก cost เป็น error usd null", async () => {
  fake(reply('{"success":false}', 400), reply(ant('{"b":2}')));
  await llmJson({ system: "s", user: "u", schema: SCHEMA, meta: { step: "x" }, costDir: dir });
  const rows = readCosts(dir);
  assert.deepEqual(rows.map((r) => r.outcome), ["error", "ok"]);
  assert.equal(rows[0].usd, null);
});

test("strip ไม่ทิ้งชื่อ property ที่ตรงกับ keyword และเข้า anyOf/items", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      enum: { type: "string" },
      minItems: { type: "integer" },
      additionalProperties: { type: "string" },
      u: { anyOf: [{ type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { k: { type: "integer", enum: [1] } } } }, { type: "null" }] },
    },
  };
  const copy = JSON.stringify(schema);
  const g = geminiStrip(schema);
  assert.deepEqual(Object.keys(g.properties), ["enum", "minItems", "additionalProperties", "u"]);
  assert.equal(g.additionalProperties, undefined);
  assert.equal(g.properties.u.anyOf[0].items.additionalProperties, undefined);
  assert.equal(g.properties.u.anyOf[0].items.properties.k.enum, undefined);
  assert.equal(g.properties.u.anyOf[0].minItems, 1);
  const a = anthropicStrip(schema);
  assert.deepEqual(Object.keys(a.properties), ["enum", "minItems", "additionalProperties", "u"]);
  assert.equal(a.properties.u.anyOf[0].minItems, undefined);
  assert.equal(a.additionalProperties, false);
  assert.equal(JSON.stringify(schema), copy);
});

test("validate ที่ throw นับเป็น issue และยังบันทึก cost", async () => {
  fake(reply(gem('{"a":1}')), reply(gem('{"a":1}')), reply(ant('{"a":1}')), reply(ant('{"a":1}')));
  await assert.rejects(
    llmJson({ system: "s", user: "u", schema: SCHEMA, validate: () => { throw new Error("x"); }, meta: { step: "x" }, costDir: dir }),
    (e) => e.code === "PROVIDER" && e.details.issues[0].includes("validator error: x"),
  );
  assert.match(bodyOf(1).input.contents[2].parts[0].text, /validator error: x/);
  assert.equal(readCosts(dir).length, 4);
});

test("usage ขาด -> usd null และเก็บเฉพาะ units ที่ API ส่งมา", async () => {
  const noOut = JSON.stringify({ success: true, result: { candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata: { promptTokenCount: 9 } } });
  fake(reply(noOut));
  await llmJson({ system: "s", user: "u", schema: SCHEMA, meta: { step: "x" }, costDir: dir });
  const [row] = readCosts(dir);
  assert.equal(row.usd, null);
  assert.deepEqual(row.units, { tokensIn: 9 });
});

test("แถว cost ของ llm มี step/item/run; content filter → outcome blocked", async () => {
  fake(reply(gem('{"b":2}')));
  await llmJson({ system: "s", user: "u", schema: SCHEMA, meta: { project: "p", step: "character", item: "heron", run: "r1" }, costDir: dir });
  fake(reply("flagged by moderation", 400));
  await assert.rejects(llmJson({ system: "s", user: "u", schema: SCHEMA, meta: { project: "p", step: "character", item: "heron", run: "r1" }, costDir: dir }), (e) => e.code === "BLOCKED");
  const rows = readCosts(dir);
  assert.deepEqual(rows.map((r) => [r.step, r.item, r.run, r.outcome]), [["character", "heron", "r1", "ok"], ["character", "heron", "r1", "blocked"]]);
});
