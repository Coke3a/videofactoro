import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VfError } from "./out.mjs";
import { ID_RE } from "./bible.mjs";

// สินค้าของ project (ช่องคลิปขายของ): products/<p>/product/product.json + รูปจริงในโฟลเดอร์เดียวกัน
// มีไฟล์นี้ = motion เข้าโหมดสินค้า (ฉากแทรกรูปจริง ฉากปิดบอกราคา); ไม่มี = คลิปตลกแบบเดิม
export const IMAGE_ROLES = ["hero", "detail", "spec"];
export const productDir = (dir) => join(dir, "product");

const text = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);

export function loadProduct(dir) {
  const file = join(productDir(dir), "product.json");
  if (!existsSync(file)) return null;
  let j;
  try {
    j = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new VfError("USAGE", `product.json อ่านไม่ได้: ${e.message}`);
  }
  const issues = [];
  const name = text(j.name);
  if (!name) issues.push("name ว่าง");
  const images = (Array.isArray(j.images) ? j.images : []).map((im, i) => {
    const id = text(im?.id);
    if (!ID_RE.test(id)) issues.push(`images[${i}].id "${id}" ต้องเป็น a-z0-9-`);
    if (!IMAGE_ROLES.includes(im?.role)) issues.push(`images[${i}].role ต้องเป็น ${IMAGE_ROLES.join("/")}`);
    const f = text(im?.file);
    if (!f || f.includes("/") || f.includes("\\") || !existsSync(join(productDir(dir), f))) issues.push(`images[${i}].file "${f}" ต้องเป็นไฟล์ในโฟลเดอร์ product/`);
    return { id, role: im?.role, file: f, feature: text(im?.feature), shows: text(im?.shows), cutout: /\.png$/i.test(f) };
  });
  if (images.filter((im) => im.role === "hero").length !== 1) issues.push("ต้องมีรูป hero 1 รูปพอดี");
  if (new Set(images.map((im) => im.id)).size !== images.length) issues.push("images id ซ้ำ");
  if (issues.length) throw new VfError("USAGE", `product.json ไม่ถูกต้อง: ${issues.join("; ")}`, { issues });
  return {
    name, brand: text(j.brand), price_text: text(j.price_text), cta: text(j.cta),
    facts: list(j.facts), claims_allowed: list(j.claims_allowed), forbidden_words: list(j.forbidden_words),
    angles: list(j.angles), images,
  };
}

// คำต้องห้ามในบทพูด/ป้าย (เช่น IPX7, TOP 1): เทียบแบบไม่สนตัวพิมพ์และช่องว่าง
export function forbiddenHits(product, s) {
  const norm = (x) => String(x ?? "").toLowerCase().replace(/\s+/g, "");
  const t = norm(s);
  return (product?.forbidden_words ?? []).filter((w) => norm(w) && t.includes(norm(w)));
}

const run = promisify(execFile);
export async function imageSize(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, h] = stdout.trim().split(",").map(Number);
  if (!(w > 0 && h > 0)) throw new VfError("USAGE", `อ่านขนาดรูปไม่ได้: ${file}`);
  return { w, h };
}
