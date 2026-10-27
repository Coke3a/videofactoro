import { MODELS } from "./models.mjs";

export const PRICES = {
  asOf: "2026-10-27",
  [MODELS.image]: { firstMp: 0.015, extraMp: 0.002, refMp: 0.002, source: "Cloudflare Workers AI pricing" },
  [MODELS.imageFast]: { inTile: 0.000059, outTile: 0.000287, source: "Cloudflare Workers AI pricing (ต่อช่อง 512x512)" },
  [MODELS.video]: { hd: 0.17, fhd: 0.29, draft: 0.06, unit: "clip", verified: false, source: "Cloudflare AI Gateway pricing (ยังไม่ยืนยัน)" },
  [MODELS.qa]: { inPerM: 0.15, source: "Cloudflare Workers AI pricing" },
  [MODELS.llm[0]]: { inPerM: 0.75, outPerM: 3.75, source: "Cloudflare AI Gateway pricing" },
  [MODELS.llm[1]]: { inPerM: 0.1, outPerM: 0.5, verified: false, source: "Cloudflare AI Gateway pricing (ยังไม่ยืนยัน)" },
  [MODELS.tts]: { perMin: 0.014, verified: false, source: "Cloudflare AI Gateway pricing (ยังไม่ยืนยัน)" },
  [MODELS.music]: { perSec: 0.0025, source: "Cloudflare AI Gateway pricing" },
  [MODELS.asr]: { perMin: 0.0005, source: "Cloudflare Workers AI pricing" },
  [MODELS.rmbg]: null,
};

const num = (v) => typeof v === "number" && Number.isFinite(v);
const QUALITIES = ["hd", "fhd", "draft"];

export function estimate(model, units = {}) {
  if (typeof model !== "string" || model === "asOf" || !Object.hasOwn(PRICES, model)) return null;
  const p = PRICES[model];
  if (typeof p !== "object" || p === null) return null;
  const u = units ?? {};
  if (p.firstMp !== undefined) {
    const mp = u.mp ?? 1;
    const images = u.images ?? 1;
    const refMp = u.refMp ?? 0;
    if (!num(mp) || !num(images) || !num(refMp)) return null;
    return (p.firstMp + Math.max(0, mp - 1) * p.extraMp + refMp * (p.refMp ?? 0)) * images;
  }
  if (p.outTile !== undefined) {
    const tiles = u.tiles ?? 4;
    const refTiles = u.refTiles ?? 0;
    const images = u.images ?? 1;
    if (!num(tiles) || !num(refTiles) || !num(images)) return null;
    return (tiles * p.outTile + refTiles * p.inTile) * images;
  }
  if (p.unit === "clip") {
    if (!QUALITIES.includes(u.quality) || !num(p[u.quality]) || !num(u.clips)) return null;
    return u.clips * p[u.quality];
  }
  if (p.inPerM !== undefined) {
    if (!num(u.tokensIn)) return null;
    if (p.outPerM === undefined) return (u.tokensIn * p.inPerM) / 1e6;
    if (!num(u.tokensOut)) return null;
    return (u.tokensIn * p.inPerM + u.tokensOut * p.outPerM) / 1e6;
  }
  if (p.perMin !== undefined) {
    if (num(u.minutes)) return u.minutes * p.perMin;
    return num(u.seconds) ? (u.seconds / 60) * p.perMin : null;
  }
  if (p.perSec !== undefined) {
    if (num(u.seconds)) return u.seconds * p.perSec;
    return num(u.minutes) ? u.minutes * 60 * p.perSec : null;
  }
  return null;
}
