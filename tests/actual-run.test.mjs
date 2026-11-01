import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEntity, pinRun, setActualCostFetcher } from "../tools/entities.mjs";
import { logCost, readActual, expectedGatewayCalls } from "../tools/cost.mjs";
import { VfError } from "../tools/out.mjs";

let dir, seen;
const stub = (rec) => setActualCostFetcher(async (q) => { seen.push(q); return { ...q, fetched_at: "t", gateway: null, ...rec }; });
const memState = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
const go = (work) => runEntity({ dir, projectRef: dir, slug: "p", command: ["x"], label: "x", foreground: true, work });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vf-actual-")); seen = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); setActualCostFetcher(null); });

test("a finished run appends one actual-cost line and returns it as cost", async () => {
  stub({ status: "ok", usd: 0.2, neurons: { total: 300, by_model: {} } });
  const out = await go(async ({ run }) => {
    logCost(join(dir, ".vf"), { project: "p", run, step: "s", item: "p-001#3", model: "m", outcome: "ok" });
    return { x: 1 };
  });
  assert.equal(out.x, 1);
  assert.deepEqual(out.cost, { usd: 0.2, status: "ok", neurons: 300 });
  const lines = readActual(join(dir, ".vf"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].project, "p");
  assert.deepEqual(lines[0].items, ["p-001"]);
  assert.equal(lines[0].outcome, "ok");
  assert.ok(lines[0].start <= lines[0].end);
});

test("a failed run still records its spend and rethrows", async () => {
  stub({ status: "ok", usd: 0.05, neurons: { total: 0, by_model: {} } });
  await assert.rejects(go(async () => { throw new VfError("BAD_INPUT", "x"); }), VfError);
  const lines = readActual(join(dir, ".vf"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].outcome, "error");
  assert.equal(lines[0].usd, 0.05);
});

test("cost lookup failure never breaks the run", async () => {
  setActualCostFetcher(async () => { throw new Error("down"); });
  const out = await go(async () => ({ x: 1 }));
  assert.equal(out.x, 1);
  assert.equal(out.cost.usd, null);
  assert.equal(out.cost.status, "unavailable");
  assert.equal(readActual(join(dir, ".vf"))[0].status, "unavailable");
});

test("the run id sent to the lookup is the pinned one, not the fresh one", async () => {
  stub({ status: "ok", usd: 0, neurons: null });
  const state = memState();
  state.set("run", { id: "pinned1" });
  await go(async ({ run }) => { pinRun(state, run); return {}; });
  assert.equal(seen[0].run, "pinned1");
});

test("two attempts of one run do not double count", async () => {
  stub({ status: "ok", usd: 0.1, neurons: null });
  const state = memState();
  await assert.rejects(go(async ({ run }) => { pinRun(state, run); throw new VfError("BAD_INPUT", "x"); }));
  await new Promise((r) => setTimeout(r, 5));
  await go(async ({ run }) => { pinRun(state, run); return {}; });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].run, seen[1].run);
  assert.ok(seen[0].end < seen[1].start, `${seen[0].end} !< ${seen[1].start}`);
});

test("expectedGatewayCalls skips @cf, cached, rerolls and rows outside the window", () => {
  const c = join(dir, ".vf");
  const row = (model, extra = {}) => logCost(c, { project: "p", run: "r1", step: "s", model, outcome: "ok", ...extra });
  row("google/gemini-3.8-flash");
  row("google/gemini-3.8-flash");
  row("@cf/cloudflare/clef");
  row("google/gemini-3.8-flash", { cached: true });
  row("google/gemini-3.8-flash", { reject_of: 0 });
  logCost(c, { project: "p", run: "other", step: "s", model: "google/gemini-3.8-flash", outcome: "ok" });
  const start = new Date(Date.now() - 60000).toISOString();
  const end = new Date(Date.now() + 60000).toISOString();
  assert.equal(expectedGatewayCalls(c, "r1", start, end), 2);
  assert.equal(expectedGatewayCalls(c, "r1", "2000-01-01T00:00:00Z", "2000-01-02T00:00:00Z"), 0);
  assert.equal(existsSync(join(c, "actual-costs.jsonl")), false);
});
