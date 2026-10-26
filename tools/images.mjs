import { randomInt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, libLoad, libFindByKey, libAdd, libUpdate } from "./cache.mjs";
import { uploadTemp } from "./r2.mjs";
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

function megapixels(bytes, resolution) {
  const d = dimensions(bytes);
  if (d && d.w > 0 && d.h > 0) return Math.round(((d.w * d.h) / 1e6) * 100) / 100;
  return RESOLUTION_MP[resolution] ?? null;
}

const PRESIGNED = /https?:\/\/[^\s"'<>\\]*X-Amz-[^\s"'<>\\]*/gi;

function scrubUrls(err, urls) {
  const clean = (t) => {
    let out = String(t).replace(PRESIGNED, "<ref-url>");
    for (const u of urls) out = out.split(u).join("<ref-url>");
    return out;
  };
  const fix = (v) => (v === undefined ? v : typeof v === "string" ? clean(v) : JSON.parse(clean(JSON.stringify(v))));
  try {
    err.message = clean(err.message);
    if ("body" in err) err.body = fix(err.body);
    if (err.details !== undefined) err.details = fix(err.details);
  } catch { /* leave as is */ }
  return err;
}

export async function generateImage({
  projectDir, prompt, refs = [], aspect = "9:16", resolution = "1k", seed, need, kind,
  characters = [], place = null, tags = [], meta = {}, status = "candidate",
}) {
  if (!kind) throw new VfError("USAGE", "generateImage ต้องระบุ kind");
  if (refs.length > MAX_REFS) throw new VfError("INTERNAL", `klein รับภาพอ้างอิงได้ไม่เกิน ${MAX_REFS} ภาพ (ส่งมา ${refs.length})`);
  const costDir = join(projectDir, ".vf");
  const row = costRow(meta, MODELS.image, meta.step ?? "image");
  const finalPrompt = prompt + SUFFIX;
  const key = cacheKey({ model: MODELS.image, prompt: finalPrompt, refs, aspect, resolution, seed });

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
  const urls = [];
  let bytes;
  try {
    for (const r of refs) urls.push(await uploadTemp(r));
    const input = { prompt: finalPrompt, aspect_ratio: aspect, resolution, seed: usedSeed };
    if (urls.length) input.images = urls;
    log(`klein: refs=${urls.length} model=${MODELS.image}`);
    let paid = false;
    try {
      const { result } = await withRetry(() => run(MODELS.image, input, { meta }));
      paid = true;
      const out = join(tmp, "out");
      await download(extractMedia(result), out);
      bytes = readFileSync(out);
    } catch (err) {
      // run สำเร็จแล้ว (จ่ายแล้ว) แต่ได้ไฟล์ไม่ครบ: ลงราคาประเมินจาก resolution ที่ขอ
      const mp = RESOLUTION_MP[resolution];
      const usd = paid && mp ? estimate(MODELS.image, { images: 1, mp }) : null;
      logCost(costDir, { ...row, outcome: failOutcome(err), units: { images: 1 }, usd });
      throw scrubUrls(err, urls);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const mp = megapixels(bytes, resolution);
  const usd = mp === null ? null : estimate(MODELS.image, { images: 1, mp });
  const added = libAdd(projectDir, {
    id: `${kind}-${key.slice(0, 12)}`, kind, key, prompt, need, model: MODELS.image, refs, characters, place, tags,
    tag_p: {}, qa: null, status, used_in: [], cost_usd: usd, seed: usedSeed, aspect, resolution,
  }, bytes, sniffExt(bytes));
  const entry = libUpdate(projectDir, added.id, { file: added.blob });
  logCost(costDir, { ...row, outcome: "ok", units: { images: 1, mp }, usd });
  return { file: join(projectDir, entry.blob), entry, cached: false, usd };
}
