import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const file = (dir) => join(dir, "costs.jsonl");

// R13: outcome ∈ ok | invalid | qa_reject | blocked | error (+ cached:true) · step = ชนิดงาน · item = id ของชิ้น (หรือ null)
export const costRow = (meta = {}, model, step) => ({
  project: meta.project,
  ...(meta.clip !== undefined ? { clip: meta.clip } : {}),
  step: step ?? meta.step,
  item: meta.item ?? null,
  run: meta.run,
  model,
});
export const failOutcome = (err) => (err?.code === "BLOCKED" ? "blocked" : "error");

export function logCost(dir, entry) {
  mkdirSync(dir, { recursive: true });
  const row = { ...entry, at: new Date().toISOString(), estimated: true };
  appendFileSync(file(dir), JSON.stringify(row) + "\n");
}

export function readCosts(dir) {
  let text;
  try {
    text = readFileSync(file(dir), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  // ledger เสียต้อง throw ดังๆ โดยตั้งใจ ห้ามเดาตัวเลข
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function summarize(entries) {
  const map = new Map();
  let totalUsd = 0;
  let cachedCount = 0;
  const unknown = new Set();
  for (const e of entries) {
    const key = `${e.step}\u0000${e.model}`;
    let r = map.get(key);
    if (!r) map.set(key, (r = { step: e.step, model: e.model, calls: 0, ok: 0, rerolls: 0, units: {}, usd: null }));
    // แถว reject_of = ภาพที่สร้างแล้ว (นับไปแล้ว) แต่ QA ไม่ผ่านและถูกสร้างใหม่: ย้ายจาก ok ไปเป็น reroll ไม่นับครั้ง/เงินซ้ำ
    if (e.reject_of !== undefined) {
      r.rerolls++;
      if (r.ok > 0) r.ok--;
      continue;
    }
    r.calls++;
    if (e.outcome === "ok") r.ok++;
    if (e.outcome === "qa_reject") r.rerolls++;
    if (e.cached) cachedCount++;
    for (const [k, v] of Object.entries(e.units ?? {})) {
      if (typeof v === "number") r.units[k] = (r.units[k] ?? 0) + v;
    }
    if (typeof e.usd === "number") {
      r.usd = (r.usd ?? 0) + e.usd;
      totalUsd += e.usd;
    } else {
      unknown.add(e.model);
    }
  }
  return { rows: [...map.values()], totalUsd, cachedCount, unknownPriceModels: [...unknown] };
}

const fmtUsd = (n) => n == null ? "?" : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const fmtUnits = (u) => Object.entries(u).map(([k, v]) => `${Number.isInteger(v) ? v : +v.toFixed(3)} ${k}`).join(", ") || "-";

export function renderCostTable(summary, usdThb) {
  const lines = ["| ขั้น | โมเดล | ครั้ง | หน่วย | USD |", "|---|---|---|---|---|"];
  for (const r of summary.rows) {
    const calls = r.rerolls ? `${r.calls} (reroll ${r.rerolls})` : `${r.calls}`;
    lines.push(`| ${r.step} | ${r.model} | ${calls} | ${fmtUnits(r.units)} | ${fmtUsd(r.usd)} |`);
  }
  const baht = Math.round(summary.totalUsd * usdThb);
  lines.push(`| **รวม** | | | | **${fmtUsd(summary.totalUsd)} (≈ ${baht} บาท)** |`);
  lines.push("");
  if (summary.cachedCount) lines.push(`ใช้ซ้ำจากคลัง: ${summary.cachedCount} รายการ`);
  if (summary.unknownPriceModels.length) lines.push(`ราคายังไม่ทราบ: ${summary.unknownPriceModels.join(", ")}`);
  lines.push("ไม่รวม: ค่า LLM ของ agent ที่สั่ง tool (Claude/Hermes) — tool มองไม่เห็นค่านี้");
  return lines.join("\n");
}
