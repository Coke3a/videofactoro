import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProduct, forbiddenHits } from "../tools/product.mjs";

const mk = (j, files = ["hero.png", "d1.jpg"]) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-product-"));
  fs.mkdirSync(path.join(dir, "product"));
  for (const f of files) fs.writeFileSync(path.join(dir, "product", f), "x");
  if (j) fs.writeFileSync(path.join(dir, "product", "product.json"), JSON.stringify(j));
  return dir;
};
const good = () => ({
  name: "Mat", price_text: "฿108", forbidden_words: ["IPX7", "TOP 1"],
  images: [{ id: "hero", role: "hero", file: "hero.png" }, { id: "d1", role: "detail", file: "d1.jpg", feature: "8 mm" }],
});

test("loadProduct: ไม่มีไฟล์ = null; ไฟล์ดี = ข้อมูลพร้อม cutout จาก .png", () => {
  assert.equal(loadProduct(mk(null)), null);
  const p = loadProduct(mk(good()));
  assert.equal(p.name, "Mat");
  assert.deepEqual(p.images.map((i) => [i.id, i.cutout]), [["hero", true], ["d1", false]]);
  assert.deepEqual(p.facts, []);
});

test("loadProduct: hero ไม่ใช่ 1 รูป, ไฟล์ไม่มี/ออกนอกโฟลเดอร์, role ผิด → USAGE", () => {
  const bad = (edit) => {
    const j = good();
    edit(j);
    assert.throws(() => loadProduct(mk(j)), (e) => e.code === "USAGE");
  };
  bad((j) => { j.images[1].role = "hero"; });
  bad((j) => { j.images[1].file = "missing.jpg"; });
  bad((j) => { j.images[1].file = "../project.json"; });
  bad((j) => { j.images[1].role = "banner"; });
  bad((j) => { j.name = ""; });
});

test("forbiddenHits: ไม่สนตัวพิมพ์และช่องว่าง", () => {
  const p = { forbidden_words: ["IPX7", "TOP 1"] };
  assert.deepEqual(forbiddenHits(p, "กันน้ำระดับ ipx 7 อันดับ top1"), ["IPX7", "TOP 1"]);
  assert.deepEqual(forbiddenHits(p, "กันลื่น"), []);
  assert.deepEqual(forbiddenHits(null, "IPX7"), []);
});
