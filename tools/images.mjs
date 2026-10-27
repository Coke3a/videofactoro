import { randomInt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, libLoad, libFindByKey, libAdd, libUpdate } from "./cache.mjs";
import { run, withRetry, extractMedia, download } from "./cf.mjs";
import { MODELS } from "./models.mjs";
import { estimate } from "./pricing.mjs";
import { logCost, costRow, failOutcome } from "./cost.mjs";
import { writeJsonAtomic } from "./state.mjs";
import { VfError, log } from "./out.mjs";

const SUFFIX = " No text, no letters, no logos, no watermark.";
const MAX_REFS = 4;

function dimensions(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

function sniffExt(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "png";
}

const RESOLUTION_MP = { "1k": 1, "2k": 4 };

// klein-9b takes width/height, not aspect_ratio/resolution: keep the area, snap both sides to 16 px.
export function sizeFor(aspect, resolution) {
  const m = /^(\d+):(\d+)$/.exec(String(aspect));
  const mp = RESOLUTION_MP[resolution];
  if (!m || !mp) throw new VfError("USAGE", `aspect/resolution ไม่รองรับ: ${aspect} ${resolution}`);
  const ratio = Number(m[1]) / Number(m[2]);
  const snap = (v) => Math.max(256, Math.round(v / 16) * 16);
  return { width: snap(Math.sqrt(mp * 2 ** 20 * ratio)), height: snap(Math.sqrt((mp * 2 ** 20) / ratio)) };
}

const tilesOf = (d) => (d && d.w > 0 && d.h > 0 ? Math.ceil(d.w / 512) * Math.ceil(d.h / 512) : 4);

// 4b คิดต่อช่อง 512x512 ของภาพที่ได้ + ภาพอ้างอิง (9b คิดต่อ MP)
const fastUsd = (out, refBytes) => estimate(MODELS.imageFast, { tiles: tilesOf(out), refTiles: refBytes.reduce((s, b) => s + tilesOf(dimensions(b)), 0) });

function megapixels(bytes, resolution) {
  const d = dimensions(bytes);
  if (d && d.w > 0 && d.h > 0) return Math.round(((d.w * d.h) / 1e6) * 100) / 100;
  return RESOLUTION_MP[resolution] ?? null;
}

// Provider/download errors can echo signed URLs; keep them out of messages and logs.
const SIGNED = /https?:\/\/[^\s"'<>\\]*X-Amz-[^\s"'<>\\]*/gi;

function scrubUrls(err) {
  const clean = (t) => String(t).replace(SIGNED, "<signed-url>");
  try {
    err.message = clean(err.message);
    if (typeof err.body === "string") err.body = clean(err.body);
    if (err.details !== undefined) err.details = JSON.parse(clean(JSON.stringify(err.details)));
  } catch { /* leave as is */ }
  return err;
}

export async function generateImage({
  projectDir, prompt, refs = [], aspect = "9:16", resolution = "1k", seed, need, kind,
  characters = [], place = null, tags = [], meta = {}, status = "candidate", model = MODELS.image,
}) {
  if (!kind) throw new VfError("USAGE", "generateImage ต้องระบุ kind");
  if (refs.length > MAX_REFS) throw new VfError("INTERNAL", `klein รับภาพอ้างอิงได้ไม่เกิน ${MAX_REFS} ภาพ (ส่งมา ${refs.length})`);
  const costDir = join(projectDir, ".vf");
  const row = costRow(meta, model, meta.step ?? "image");
  const finalPrompt = prompt + SUFFIX;
  const key = cacheKey({ model, prompt: finalPrompt, refs, aspect, resolution, seed });

  const hit = libFindByKey(libLoad(projectDir), key);
  if (hit && existsSync(join(projectDir, hit.blob))) {
    logCost(costDir, { ...row, outcome: "ok", units: { images: 1 }, usd: 0, cached: true });
    return { file: join(projectDir, hit.blob), entry: hit, cached: true, usd: 0 };
  }

  if (hit) {
    const lib = libLoad(projectDir);
    lib.entries = lib.entries.filter((e) => e.id !== hit.id);
    writeJsonAtomic(join(projectDir, "library", "index.json"), lib);
  }
  const usedSeed = seed ?? randomInt(0, 2 ** 32);
  const tmp = mkdtempSync(join(tmpdir(), "vf-img-"));
  const refBytes = refs.map((r) => readFileSync(r));
  // ภาพอ้างอิงคิดเงินตาม MP ของภาพที่ส่ง (อ่านขนาดไม่ได้ให้นับ 1 MP)
  const refMp = refBytes.reduce((sum, b) => sum + (megapixels(b, null) ?? 1), 0);
  let bytes;
  try {
    const { width, height } = sizeFor(aspect, resolution);
    const input = { prompt: finalPrompt, width: String(width), height: String(height), seed: String(usedSeed) };
    refBytes.forEach((b, i) => { input[`input_image_${i}`] = b; });
    log(`klein: refs=${refs.length} ${width}x${height} model=${model}`);
    let paid = false;
    try {
      const { result } = await withRetry(() => run(model, input, { meta, multipart: true }));
      paid = true;
      const out = join(tmp, "out");
      await download(extractMedia(result), out);
      bytes = readFileSync(out);
    } catch (err) {
      // run สำเร็จแล้ว (จ่ายแล้ว) แต่ได้ไฟล์ไม่ครบ: ลงราคาประเมินจากขนาดที่ขอ
      const usd = !paid ? null
        : model === MODELS.imageFast ? fastUsd({ w: width, h: height }, refBytes)
          : estimate(model, { images: 1, mp: (width * height) / 1e6, refMp });
      logCost(costDir, { ...row, outcome: failOutcome(err), units: { images: 1 }, usd });
      throw scrubUrls(err);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const mp = megapixels(bytes, resolution);
  const usd = model === MODELS.imageFast ? fastUsd(dimensions(bytes), refBytes)
    : mp === null ? null : estimate(model, { images: 1, mp, refMp });
  const added = libAdd(projectDir, {
    id: `${kind}-${key.slice(0, 12)}`, kind, key, prompt, need, model, refs, characters, place, tags,
    tag_p: {}, qa: null, status, used_in: [], cost_usd: usd, seed: usedSeed, aspect, resolution,
  }, bytes, sniffExt(bytes));
  const entry = libUpdate(projectDir, added.id, { file: added.blob });
  logCost(costDir, { ...row, outcome: "ok", units: { images: 1, mp }, usd });
  return { file: join(projectDir, entry.blob), entry, cached: false, usd };
}
