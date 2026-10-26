import { test, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { setFetch, setSleep } from "../tools/cf.mjs";
import { main } from "../tools/setup.mjs";

const KEYS = ["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "VF_AIG_GATEWAY_ID"];
process.env.VF_NO_DOTENV = "1";
let saved, origWrite, errLog, costDir;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    CLOUDFLARE_AI_ACCOUNT_ID: "acc123", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456",
  });
  delete process.env.VF_AIG_GATEWAY_ID;
  costDir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-setup-cost-"));
  setSleep(async () => {});
  origWrite = process.stderr.write;
  errLog = [];
  process.stderr.write = (c) => { errLog.push(String(c)); return true; };
});
afterEach(() => {
  process.stderr.write = origWrite;
  fs.rmSync(costDir, { recursive: true, force: true });
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  setFetch((...a) => globalThis.fetch(...a));
});

const runBodies = [];
function fakeCloudflare() {
  const seen = [];
  setFetch(async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    seen.push(`${method} ${u.hostname}${u.pathname}`);
    if (u.hostname === "api.cloudflare.com" && u.pathname.endsWith("/ai/models/search")) return new Response("{}", { status: 200 });
    if (u.pathname.includes("/ai/run")) {
      runBodies.push(JSON.parse(init.body));
      const text = '{"ok":true}';
      return new Response(JSON.stringify({ success: true, result: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } } }), { status: 200 });
    }
    throw new Error("unexpected " + method + " " + url);
  });
  return seen;
}

test("setup: ทุก check ผ่านด้วย Cloudflare ปลอม ไม่มี R2 และคีย์ไม่หลุด", async () => {
  const seen = fakeCloudflare();
  const { checks } = await main([], { costDir });
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  for (const n of ["cf:token", "cf:credits"]) assert.equal(by[n].ok, true, n + " " + by[n].detail);
  assert.ok(!checks.some((c) => c.name.startsWith("r2:")));
  assert.ok(!seen.some((s) => s.includes("r2.cloudflarestorage.com")));
  assert.equal(runBodies.at(-1).input.generationConfig.maxOutputTokens, 2112);
  const text = JSON.stringify(checks) + errLog.join("");
  assert.ok(!text.includes("tok-secret-123456"));
});

test("setup: env หลักขาด -> CONFIG พร้อม checks และไม่เรียกเครือข่าย", async () => {
  delete process.env.CLOUDFLARE_AI_API_TOKEN;
  const seen = fakeCloudflare();
  await assert.rejects(main([], { costDir }), (e) => e.code === "CONFIG" && Array.isArray(e.details.checks));
  assert.equal(seen.length, 0);
});
