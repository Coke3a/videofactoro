import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODELS } from "../tools/models.mjs";
import { PRICES, estimate } from "../tools/pricing.mjs";
import { logCost, readCosts, summarize, renderCostTable } from "../tools/cost.mjs";

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("estimate klein-4b: ต่อช่อง 512x512 ของภาพที่ได้ + ภาพอ้างอิง", () => {
  // 768x1360 = 2x3 = 6 ช่อง, ref 1024x1024 สองภาพ = 8 ช่อง
  near(estimate(MODELS.imageFast, { tiles: 6, refTiles: 8 }), 6 * 0.000287 + 8 * 0.000059);
  near(estimate(MODELS.imageFast, { images: 2, tiles: 6, refTiles: 0 }), 2 * 6 * 0.000287);
  assert.equal(estimate(MODELS.imageFast, { tiles: "x" }), null);
});

test("estimate klein-9b 1MP = 0.015", () => {
  near(estimate(MODELS.image, { mp: 1 }), 0.015);
  near(estimate(MODELS.image, { images: 2, mp: 1 }), 0.03);
  near(estimate(MODELS.image, { images: 3 }), 0.045);
});

test("estimate klein-9b 1.5MP = 0.016 และภาพอ้างอิงคิด 0.002 ต่อ MP", () => {
  near(estimate(MODELS.image, { mp: 1.5 }), 0.016);
  near(estimate(MODELS.image, { mp: 1, refMp: 2 }), 0.019);
  assert.equal(estimate(MODELS.image, { mp: 1, refMp: "x" }), null);
});

test("estimate video hd 1 คลิป = 0.17", () => {
  near(estimate(MODELS.video, { clips: 1, quality: "hd" }), 0.17);
  near(estimate(MODELS.video, { clips: 2, quality: "draft" }), 0.12);
});

test("estimate llm/tts/asr/music/unknown", () => {
  near(estimate(MODELS.llm[0], { tokensIn: 1e6, tokensOut: 1e6 }), 4.5);
  near(estimate(MODELS.qa, { tokensIn: 2e6 }), 0.3);
  near(estimate(MODELS.music, { seconds: 10 }), 0.025);
  near(estimate(MODELS.asr, { minutes: 2 }), 0.001);
  near(estimate(MODELS.tts, { minutes: 1 }), 0.014);
  assert.equal(estimate(MODELS.rmbg, { images: 1 }), null);
  assert.equal(estimate("nope/model", {}), null);
  assert.equal(PRICES.asOf, "2026-10-27");
});

test("summarize นับ reroll", () => {
  const e = (outcome) => ({ step: "keyframe", model: "m", units: { images: 1 }, usd: 0.01, outcome });
  const s = summarize([e("ok"), e("qa_reject"), e("ok")]);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].calls, 3);
  assert.equal(s.rows[0].ok, 2);
  assert.equal(s.rows[0].rerolls, 1);
  assert.equal(s.rows[0].units.images, 3);
  near(s.totalUsd, 0.03);
});

test("summarize นับรายการ cached แยก และ usd null ไม่รวมในยอด", () => {
  const s = summarize([
    { step: "keyframe", model: "a", units: {}, usd: 0.5, outcome: "ok" },
    { step: "keyframe", model: "a", units: {}, usd: 0, outcome: "ok", cached: true },
    { step: "rmbg", model: "bria/remove-background", units: {}, usd: null, outcome: "ok" },
  ]);
  assert.equal(s.cachedCount, 1);
  assert.equal(s.rows.find((r) => r.model === "a").ok, 2);
  near(s.totalUsd, 0.5);
  assert.deepEqual(s.unknownPriceModels, ["bria/remove-background"]);
});

test("logCost/readCosts เติม at และ estimated", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-cost-"));
  try {
    assert.deepEqual(readCosts(dir), []);
    logCost(dir, { project: "p", step: "keyframe", model: "m", units: { images: 1 }, usd: 0.009, outcome: "ok" });
    logCost(dir, { project: "p", step: "keyframe", model: "m", units: {}, usd: null, outcome: "error" });
    const rows = readCosts(dir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].estimated, true);
    assert.match(rows[0].at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(readFileSync(join(dir, "costs.jsonl"), "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderCostTable มียอดบาท", () => {
  const md = renderCostTable(
    { rows: [{ step: "keyframe", model: "m", calls: 3, ok: 2, rerolls: 1, units: { images: 3 }, usd: 1.5 }], totalUsd: 1.5, cachedCount: 2, unknownPriceModels: ["x/y"] },
    33.5,
  );
  assert.ok(md.includes("≈ 50 บาท"));
  assert.ok(md.includes("| ขั้น | โมเดล | ครั้ง | หน่วย | USD |"));
  assert.ok(md.includes("$1.50"));
  assert.ok(md.includes("ราคายังไม่ทราบ: x/y"));
  assert.ok(md.includes("ไม่รวม: ค่า LLM ของ agent ที่สั่ง tool (Claude/Hermes) — tool มองไม่เห็นค่านี้"));
  assert.ok(renderCostTable({ rows: [{ step: "s", model: "m", calls: 1, ok: 1, rerolls: 0, units: {}, usd: 0.0034 }], totalUsd: 0.0034, cachedCount: 0, unknownPriceModels: [] }, 33.5).includes("$0.0034"));
});

test("estimate ไม่เดา: quality แปลก, หน่วยขาด, key แปลก -> null", () => {
  assert.equal(estimate(MODELS.video, { clips: 1, quality: "4k" }), null);
  assert.equal(estimate(MODELS.video, { quality: "4k" }), null);
  assert.equal(estimate(MODELS.video, { clips: 1 }), null);
  assert.equal(estimate(MODELS.video, { clips: NaN, quality: "hd" }), null);
  assert.equal(estimate(MODELS.llm[0], {}), null);
  assert.equal(estimate(MODELS.llm[0], { tokensIn: 100 }), null);
  assert.equal(estimate(MODELS.llm[0], { tokensIn: "5", tokensOut: 1 }), null);
  assert.equal(estimate(MODELS.qa, {}), null);
  assert.equal(estimate(MODELS.music, {}), null);
  assert.equal(estimate(MODELS.asr, { minutes: Infinity }), null);
  assert.equal(estimate(MODELS.image, { mp: NaN }), null);
  assert.equal(estimate("asOf", {}), null);
  assert.equal(estimate("toString", {}), null);
  assert.equal(estimate("__proto__", {}), null);
});

test("renderCostTable แถวที่ usd เป็น null ทุกรายการแสดง ?", () => {
  const s = summarize([{ step: "rmbg", model: "bria/remove-background", units: {}, usd: null, outcome: "ok" }]);
  assert.equal(s.rows[0].usd, null);
  const md = renderCostTable(s, 33.5);
  assert.ok(md.includes("| ? |"));
  assert.ok(!md.includes("| $0.00 |"));
});

test("summarize: แถว qa_reject ที่ชี้ reject_of ย้าย ok → reroll ไม่นับครั้งและเงินซ้ำ", () => {
  const s = summarize([
    { step: "plate", model: "m", units: { images: 1 }, usd: 0.01, outcome: "ok" },
    { step: "plate", model: "m", units: {}, usd: 0, outcome: "qa_reject", reject_of: "e1" },
    { step: "plate", model: "m", units: { images: 1 }, usd: 0.01, outcome: "ok" },
  ]);
  assert.deepEqual(s.rows, [{ step: "plate", model: "m", calls: 2, ok: 1, rerolls: 1, units: { images: 2 }, usd: 0.02 }]);
  assert.equal(s.totalUsd, 0.02);
});
