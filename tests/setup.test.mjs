import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setFetch, setSleep } from "../tools/cf.mjs";
import { main } from "../tools/setup.mjs";

const KEYS = ["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "VF_R2_BUCKET", "VF_R2_ACCESS_KEY_ID", "VF_R2_SECRET_ACCESS_KEY", "VF_R2_TOKEN"];
let saved, origWrite;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    CLOUDFLARE_AI_ACCOUNT_ID: "acc123", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456", VF_R2_BUCKET: "bkt",
    VF_R2_ACCESS_KEY_ID: "AKID", VF_R2_SECRET_ACCESS_KEY: "SECRETSECRET",
  });
  delete process.env.VF_R2_TOKEN;
  setSleep(async () => {});
  origWrite = process.stderr.write;
  process.stderr.write = () => true;
});
afterEach(() => {
  process.stderr.write = origWrite;
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  setFetch((...a) => globalThis.fetch(...a));
});

function fakeCloudflare({ bucketExists = false, corrupt = false } = {}) {
  const objects = new Map();
  const seen = [];
  setFetch(async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    seen.push(`${method} ${u.hostname}${u.pathname}`);
    if (u.hostname === "api.cloudflare.com" && u.pathname.endsWith("/ai/models/search")) return new Response("{}", { status: 200 });
    if (u.pathname.includes("/ai/run")) {
      const text = '{"ok":true}';
      return new Response(JSON.stringify({ success: true, result: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } } }), { status: 200 });
    }
    if (u.hostname.endsWith("r2.cloudflarestorage.com")) {
      if (u.pathname === "/bkt") {
        if (method === "HEAD") return new Response(null, { status: bucketExists ? 200 : 404 });
        return new Response(null, { status: 200 });
      }
      if (method === "HEAD") return new Response(null, { status: objects.has(u.pathname) ? 200 : 404 });
      if (method === "PUT") { objects.set(u.pathname, Buffer.from(init.body)); return new Response(null, { status: 200 }); }
      if (method === "GET") {
        const b = objects.get(u.pathname);
        return b ? new Response(corrupt ? Buffer.alloc(16) : b, { status: 200 }) : new Response(null, { status: 404 });
      }
    }
    throw new Error("unexpected " + method + " " + url);
  });
  return seen;
}

test("setup: ทุก check ผ่านด้วย Cloudflare ปลอม และ URL/คีย์ไม่หลุด", async () => {
  const seen = fakeCloudflare();
  const { checks } = await main([]);
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  for (const n of ["cf:token", "r2:bucket", "r2:presign", "cf:credits"]) assert.equal(by[n].ok, true, n + " " + by[n].detail);
  assert.ok(seen.some((s) => s.startsWith("PUT") && s.endsWith("/bkt")));
  const text = JSON.stringify(checks);
  for (const v of ["SECRETSECRET", "tok-secret-123456", "X-Amz"]) assert.ok(!text.includes(v), v);
});

test("setup: r2:presign ล้มเมื่อไบต์ที่ได้กลับมาไม่ตรง แต่คำสั่งยังคืน checks", async () => {
  fakeCloudflare({ corrupt: true });
  const { checks } = await main([]);
  const p = checks.find((c) => c.name === "r2:presign");
  assert.equal(p.ok, false);
  assert.ok(!p.detail.includes("X-Amz"));
});

test("setup: env หลักขาด -> CONFIG พร้อม checks และไม่เรียกเครือข่าย", async () => {
  delete process.env.VF_R2_BUCKET;
  const seen = fakeCloudflare();
  await assert.rejects(main([]), (e) => e.code === "CONFIG" && Array.isArray(e.details.checks));
  assert.equal(seen.length, 0);
});
