import { MODELS } from "./models.mjs";

export const PRICES = {
  asOf: "2026-10-26",
  [MODELS.image]: { firstMp: 0.009, extraMp: 0.0017, source: "Cloudflare Workers AI pricing" },
  [MODELS.video]: { hd: 0.17, fhd: 0.29, draft: 0.06, unit: "clip", verified: false, source: "Cloudflare AI Gateway pricing (ยังไม่ยืนยัน)" },
  [MODELS.qa]: { inPerM: 0.15, source: "Cloudflare Workers AI pricing" },
  [MODELS.llm[0]]: { inPerM: 0.75, outPerM: 3.75, source: "Cloudflare AI Gateway pricing" },
  [MODELS.llm[1]]: { inPerM: 0.1, outPerM: 0.5, verified: false, source: "Cloudflare AI Gateway pricing (ยังไม่ยืนยัน)" },
  [MODELS.tts]: { perMin: 0.014, verified: false, source: "Cloudflare AI Gateway pricing (ยังไม่ยืนยัน)" },
  [MODELS.music]: { perSec: 0.0025, source: "Cloudflare AI Gateway pricing" },
  [MODELS.asr]: { perMin: 0.0005, source: "Cloudflare Workers AI pricing" },
  [MODELS.rmbg]: null,
};

export function estimate(model, units = {}) {
  const p = PRICES[model];
  if (!p || model === "asOf") return null;
  const u = units;
  if (p.firstMp !== undefined) {
    const mp = u.mp ?? 1;
    const per = p.firstMp + Math.max(0, mp - 1) * p.extraMp;
    return per * (u.images ?? 1);
  }
  if (p.unit === "clip") {
    const price = p[u.quality ?? "hd"];
    return price === undefined ? null : (u.clips ?? 1) * price;
  }
  if (p.inPerM !== undefined) {
    return ((u.tokensIn ?? 0) * p.inPerM + (u.tokensOut ?? 0) * (p.outPerM ?? 0)) / 1e6;
  }
  if (p.perMin !== undefined) return (u.minutes ?? (u.seconds ?? 0) / 60) * p.perMin;
  if (p.perSec !== undefined) return (u.seconds ?? (u.minutes ?? 0) * 60) * p.perSec;
  return null;
}
