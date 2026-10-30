import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log, VfError } from "./out.mjs";
import { step, writeJsonAtomic } from "./state.mjs";
import { generateImage } from "./images.mjs";
import { MODELS } from "./models.mjs";
import { baseSeed } from "./project-create.mjs";
import { cutout } from "./cutout.mjs";
import { ID_RE } from "./bible.mjs";

const run = promisify(execFile);
const BIG = { maxBuffer: 1 << 30, encoding: "buffer" };

export const PROP_ID_RE = ID_RE;
// upright = ตั้งบนพื้น (ค่าเดิม) · floor = ของที่ปูราบกับพื้น เช่น เสื่อ พรม ตัวละครยืน/ทำท่าบนนั้นได้
export const PLACEMENTS = ["upright", "floor"];
export const propDir = (dir, id) => join(dir, "props", id);
const noState = { get: () => undefined, set() {} };

// เรียกตรงได้จาก vf motion (ไม่ต้องมี job/state); state ใส่มาเฉพาะตอนต้องการ checkpoint
export async function makeProp({ dir, slug, id, desc, run: runId, costDir, state = noState }) {
  const pj = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const out = propDir(dir, id);
  const raw = await stepOnce(state, "gen", async () => {
    log(`ขั้น prop:${id}`);
    const img = await generateImage({
      projectDir: dir, model: MODELS.imageFast, aspect: "1:1", seed: baseSeed(slug, `prop:${id}`),
      prompt: `${desc}. A single object, whole object visible, centered, on a plain flat light cream background, no shadow, nothing else. ${pj.style_prompt}`,
      need: `prop:${id}`, kind: "prop", tags: [id], meta: { project: slug, step: "prop", item: id, run: runId },
    });
    return { raw: img.file };
  });
  await stepOnce(state, "cut", async () => {
    log(`ขั้น cut:${id}`);
    mkdirSync(out, { recursive: true });
    await cutout(raw.raw, join(out, "prop.png"), { shadowTol: 0 }); // prop ไม่มีเงา ข้าม shadow pass
    writeJsonAtomic(join(out, "prop.json"), { id, desc, created: new Date().toISOString() });
    return { done: true };
  });
  return { id, file: `props/${id}/prop.png` };
}

const stepOnce = (state, name, fn) => (state === noState ? fn() : step(state, `prop:${name}`, fn));

async function readRgba(file) {
  try {
    const p = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
    const [w, h] = p.stdout.trim().split(",").map(Number);
    const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], BIG);
    if (!w || !h || stdout.length < w * h * 4) throw new Error("decode ไม่ครบ");
    return { w, h, px: stdout };
  } catch (e) {
    throw new VfError("USAGE", `อ่านรูปไม่ได้: ${file}`, { err: String(e.message).slice(0, 200) });
  }
}

// กรอบของพิกเซลทึบ (alpha > 8): รูปจริงมักมีขอบใสรอบสินค้า ถ้าไม่ตัดออก สัดส่วนและขนาดในฉากจะเพี้ยน
export function opaqueBox({ w, h, px }) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// สัดส่วนที่ว่างใสใต้วัตถุ (0–1 ของความสูงภาพ) เช่น ที่ว่างใต้เท้าของภาพท่า
export async function bottomGap(file) {
  const img = await readRgba(file);
  const b = opaqueBox(img);
  return b ? Math.round(((img.h - b.y - b.h) / img.h) * 1000) / 1000 : 0;
}

// prop จากรูปจริง เช่น สินค้า (ไม่เรียก API ไม่เสียเงิน): ตัดขอบใสออก
// floor: หมุนให้ด้านยาวเป็นแนวนอน เพราะตอนวางฉากจะเอียงภาพลงไปนอนกับพื้นตามแนวกว้างของจอ
// size_cm = ความยาวด้านยาวสุดของของจริง ใช้กำหนดขนาดเทียบกับตัวละคร (ไม่มี = ขนาดมาตรฐาน)
export async function importProp({ dir, id, desc, image, placement = "upright", sizeCm = null }) {
  if (!PLACEMENTS.includes(placement)) throw new VfError("USAGE", `--placement ต้องเป็น ${PLACEMENTS.join(" หรือ ")}`);
  if (sizeCm !== null && !(sizeCm > 0 && sizeCm <= 1000)) throw new VfError("USAGE", "--size-cm ต้องเป็นตัวเลข 1–1000");
  if (!existsSync(image)) throw new VfError("USAGE", `ไม่พบไฟล์รูป: ${image}`);
  const box = opaqueBox(await readRgba(image));
  if (!box) throw new VfError("USAGE", `รูปโปร่งใสทั้งภาพ: ${image}`);
  const turn = placement === "floor" && box.h > box.w;
  const out = propDir(dir, id);
  mkdirSync(out, { recursive: true });
  const filters = [`crop=${box.w}:${box.h}:${box.x}:${box.y}`, ...(turn ? ["transpose=1"] : [])].join(",");
  await run("ffmpeg", ["-v", "error", "-y", "-i", image, "-vf", filters, "-frames:v", "1", join(out, "prop.png")]);
  const [w, h] = turn ? [box.h, box.w] : [box.w, box.h];
  const aspect = Math.round((w / h) * 1000) / 1000;
  writeJsonAtomic(join(out, "prop.json"), { id, desc, placement, size_cm: sizeCm, aspect, source: image, created: new Date().toISOString() });
  return { id, file: `props/${id}/prop.png`, placement, size_cm: sizeCm, aspect };
}

export function listProps(dir) {
  const root = join(dir, "props");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "prop.json")) && existsSync(join(root, e.name, "prop.png")))
    .flatMap((e) => {
      let j;
      try {
        j = JSON.parse(readFileSync(join(root, e.name, "prop.json"), "utf8"));
      } catch {
        return []; // prop.json เสีย → ข้าม
      }
      // prop ที่สร้างจาก prompt ไม่มี placement/aspect → ตั้งบนพื้น ภาพจัตุรัส 1:1 เหมือนเดิม
      return [{
        id: j.id ?? e.name, desc: j.desc ?? "", file: `props/${e.name}/prop.png`,
        placement: PLACEMENTS.includes(j.placement) ? j.placement : "upright",
        size_cm: j.size_cm > 0 ? j.size_cm : null,
        aspect: j.aspect > 0 ? j.aspect : 1,
        trimmed: Boolean(j.source),
      }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
