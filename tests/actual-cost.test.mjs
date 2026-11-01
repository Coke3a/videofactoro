import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as cf from "../tools/cf.mjs";
import { fetchActualCost } from "../tools/actual-cost.mjs";

const TOKEN = "tok-secret";
const W = { run: "r1", start: "2026-11-01T13:30:00.000Z", end: "2026-11-01T13:40:00.000Z" };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
let ids = 0;
const log = (model, cost, run = "r1", extra = {}) => ({ id: `L${++ids}`, model, provider: "p", cost, metadata: { run }, ...extra });
const page = (rows, { page = 1, total = rows.length } = {}) => json({ success: true, result: rows, result_info: { page, per_page: 50, total_count: total } });
const gql = (groups) => json({ data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: groups }] } } });

let calls, sleeps;
// logs: ฟังก์ชัน (url, ครั้งที่) → reply · graphql: reply
function fake({ logs, graphql = gql([]) }) {
  calls = [];
  let n = 0;
  cf.setFetch(async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/graphql")) return typeof graphql === "function" ? graphql() : graphql;
    return logs(url, n++);
  });
}
const logCalls = () => calls.filter((c) => c.url.includes("/logs"));

beforeEach(() => {
  process.env.CLOUDFLARE_AI_ACCOUNT_ID = "acc1";
  process.env.CLOUDFLARE_AI_API_TOKEN = TOKEN;
  delete process.env.VF_AIG_GATEWAY_ID;
  sleeps = [];
  cf.setSleep(async (ms) => { sleeps.push(ms); });
});
afterEach(() => { for (const k of ["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN"]) delete process.env[k]; });

test("sums gateway cost per model and reads neurons", async () => {
  fake({
    logs: () => page([log("google/gemini-3.8-flash", 0.02), log("google/gemini-3.8-flash", 0.02), log("elevenlabs/music-v2", 0.18)]),
    graphql: gql([{ dimensions: { modelId: "@cf/cloudflare/clef" }, sum: { totalNeurons: 120.5 }, count: 3 }]),
  });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 3 });
  near(r.usd, 0.22);
  assert.equal(r.status, "ok");
  assert.equal(r.gateway.calls, 3);
  assert.equal(r.gateway.by_model["google/gemini-3.8-flash"].calls, 2);
  near(r.gateway.by_model["google/gemini-3.8-flash"].usd, 0.04);
  assert.deepEqual(r.neurons, { total: 120.5, by_model: { "@cf/cloudflare/clef": 120.5 } });
  assert.equal(r.run, "r1");
  assert.equal(r.start, W.start);
  assert.equal(r.end, W.end);
  assert.ok(r.fetched_at);
});

test("metadata may arrive as a JSON string", async () => {
  fake({ logs: () => page([{ model: "m", cost: 0.1, metadata: '{"run":"r1"}' }]) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 1 });
  assert.equal(r.gateway.calls, 1);
  near(r.usd, 0.1);
});

test("ignores logs whose run differs", async () => {
  fake({ logs: () => page([log("m", 0.1), { model: "m", cost: 5, metadata: { run: "other", item: "r1" } }]) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 1 });
  assert.equal(r.gateway.calls, 1);
  near(r.usd, 0.1);
});

test("sends the JSON filter and the window", async () => {
  fake({ logs: () => page([]) });
  await fetchActualCost({ ...W, expectedGatewayCalls: 0 });
  const u = logCalls()[0].url;
  assert.ok(u.includes("/accounts/acc1/ai-gateway/gateways/default/logs"), u);
  assert.ok(u.includes("filters=" + encodeURIComponent(JSON.stringify([{ key: "metadata.value", operator: "eq", value: ["r1"] }]))), u);
  // logs กรองด้วย run อย่างเดียว (ทุก attempt ของ run) แล้วตัดที่เคยบันทึกด้วย id · ช่วงเวลาใช้กับ Neurons เท่านั้น
  assert.ok(!u.includes("start_date"), u);
  assert.ok(!u.includes("filters%5B0%5D"), u);
  assert.equal(logCalls()[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  const body = JSON.parse(calls.find((c) => c.url.includes("/graphql")).init.body);
  assert.equal(body.variables.s, W.start);
  assert.equal(body.variables.e, W.end);
  assert.equal(body.variables.a, "acc1");
});

test("uses VF_AIG_GATEWAY_ID when set", async () => {
  process.env.VF_AIG_GATEWAY_ID = "gw2";
  fake({ logs: () => page([]) });
  await fetchActualCost({ ...W, expectedGatewayCalls: 0 });
  assert.ok(logCalls()[0].url.includes("/gateways/gw2/logs"));
  delete process.env.VF_AIG_GATEWAY_ID;
});

test("pages through all logs", async () => {
  const fifty = Array.from({ length: 50 }, () => log("m", 0.01));
  fake({ logs: (url) => (url.includes("page=2") ? page([log("m", 0.01)], { page: 2, total: 51 }) : page(fifty, { total: 51 })) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 51 });
  assert.equal(r.gateway.calls, 51);
  assert.ok(logCalls()[1].url.includes("page=2"));
  near(r.usd, 0.51);
});

test("waits for late logs, then ok", async () => {
  fake({ logs: (url, n) => (n === 0 ? page([log("m", 0.1)]) : page([log("m", 0.1), log("m", 0.1), log("m", 0.1)])) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 3 });
  assert.equal(r.status, "ok");
  assert.equal(r.gateway.calls, 3);
  assert.ok(sleeps.includes(15000));
});

test("waits for late logs, then partial", async () => {
  fake({ logs: () => page([log("m", 0.1)]) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 3 });
  assert.equal(r.status, "partial");
  near(r.usd, 0.1);
  assert.equal(logCalls().length, 6);
});

test("cached logs count as calls at their reported cost", async () => {
  fake({ logs: () => page([log("m", 0.1), log("m", 0, "r1", { cached: true })]) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 2 });
  assert.equal(r.gateway.calls, 2);
  near(r.usd, 0.1);
});

test("unavailable on 403", async () => {
  fake({ logs: () => json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 1 });
  assert.equal(r.status, "unavailable");
  assert.equal(r.usd, null);
  assert.match(r.error, /403/);
});

test("unavailable on network error, without leaking the token", async () => {
  calls = [];
  cf.setFetch(async () => { throw new Error(`boom ${TOKEN}`); });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 1 });
  assert.equal(r.status, "unavailable");
  assert.equal(r.usd, null);
  assert.ok(!r.error.includes(TOKEN), r.error);
});

test("graphql failure keeps usd", async () => {
  fake({ logs: () => page([log("m", 0.1)]), graphql: json({ errors: [{ message: "not authorized" }] }) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 1 });
  near(r.usd, 0.1);
  assert.equal(r.neurons, null);
  assert.equal(r.status, "partial");
});

test("no gateway calls expected", async () => {
  fake({ logs: () => page([]) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 0 });
  assert.equal(r.usd, 0);
  assert.equal(r.status, "ok");
  assert.deepEqual(sleeps, []);
});

test("a log with no cost makes the result partial and names the model", async () => {
  fake({ logs: () => page([log("m", 0.1), log("new/model", null)]) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 2 });
  assert.equal(r.status, "partial");
  near(r.usd, 0.1);
  assert.deepEqual(r.unpriced_models, ["new/model"]);
});

test("@cf rows and unknown-provider poll rows are neither paid calls nor dollars", async () => {
  fake({ logs: (url, n) => page(n === 0
    ? [log("@cf/cloudflare/clef", 0.5), log("@cf/cloudflare/clef", 0.5), log("black-forest-labs/flux-3-video", 0, "r1", { provider: "unknown" })]
    : [log("google/gemini-3.8-flash", 0.04)]) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 1 });
  assert.equal(r.gateway.calls, 1);
  near(r.usd, 0.04);
  assert.equal(logCalls().length, 2, "ไม่หยุดเพราะนับแถว @cf/poll");
});

test("logs already recorded by an earlier attempt are skipped, and count toward expected", async () => {
  ids = 0;
  fake({ logs: () => page([log("m", 0.1), log("m", 0.2)]) });
  const first = await fetchActualCost({ ...W, expectedGatewayCalls: 2 });
  ids = 0;
  fake({ logs: () => page([log("m", 0.1), log("m", 0.2), log("m", 0.3)]) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 3, seenIds: first.log_ids });
  near(r.usd, 0.3);
  assert.equal(r.gateway.calls, 1);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.log_ids, ["L3"]);
  assert.deepEqual(sleeps, []);
});

test("rows repeated across pages are counted once", async () => {
  const fifty = Array.from({ length: 50 }, () => log("m", 0.01));
  fake({ logs: (url) => (url.includes("page=2") ? page([fifty[49]], { page: 2, total: 51 }) : page(fifty, { total: 51 })) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 50 });
  assert.equal(r.gateway.calls, 50);
});

test("neurons are marked account-wide for the window", async () => {
  fake({ logs: () => page([]) });
  const r = await fetchActualCost({ ...W, expectedGatewayCalls: 0 });
  assert.equal(r.neurons_scope, "account-window");
});
