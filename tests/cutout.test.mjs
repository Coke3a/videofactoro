import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cutout } from "../tools/cutout.mjs";

process.env.VF_NO_DOTENV = "1";
let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-cutout-")); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const CREAM = "0xF5EBD2", BROWN = "0x5A3A1E", TAN = "0xCDB996", DARK = "0x281E14";
// สร้างภาพทดสอบด้วย ffmpeg: พื้นครีม + กล่องวาดตามลำดับ [x,y,w,h,color]
function make(name, boxes, size = "200x200", bg = CREAM) {
  const f = path.join(dir, name);
  const vf = boxes.map(([x, y, w, h, c]) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${c}:t=fill`).join(",");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${bg}:s=${size}`, ...(vf ? ["-vf", vf] : []), "-frames:v", "1", f]);
  return f;
}
function rgbaAt(png, w) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 });
  return (x, y) => [...raw.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
}
const alphaAt = (png, w) => { const at = rgbaAt(png, w); return (x, y) => at(x, y)[3]; };
const square = [[50, 40, 100, 100, BROWN], [54, 44, 92, 92, CREAM]];

test("cutout: ตัวกล่องทึบ พื้นหลังโปร่ง", async () => {
  const src = make("a.png", square), dst = path.join(dir, "a-out.png");
  const r = await cutout(src, dst);
  const a = alphaAt(dst, 200, 200);
  assert.equal(a(100, 90), 255);
  assert.equal(a(2, 2), 0);
  assert.equal(r.w, 200); assert.equal(r.h, 200);
  assert.ok(r.transparent > 0.7 && r.transparent < 0.8);
});

test("cutout: เงาใต้เท้าโปร่ง", async () => {
  const src = make("b.png", [...square, [60, 140, 80, 20, TAN]]), dst = path.join(dir, "b-out.png");
  await cutout(src, dst);
  const a = alphaAt(dst, 200, 200);
  assert.equal(a(100, 150), 0);
  assert.equal(a(100, 90), 255);
  // shadowTol: 0 ปิดขั้นเงา
  const dst2 = path.join(dir, "b2-out.png");
  await cutout(src, dst2, { shadowTol: 0 });
  assert.equal(alphaAt(dst2, 200, 200)(100, 150), 255);
});

test("cutout: รูรั่ว 3px ถูกกู้คืนให้ด้านในทึบ", async () => {
  const src = make("c.png", [...square, [98, 136, 3, 4, CREAM]]), dst = path.join(dir, "c-out.png");
  const r = await cutout(src, dst);
  const a = alphaAt(dst, 200, 200);
  assert.equal(a(100, 90), 255);
  assert.equal(a(2, 2), 0);
  assert.ok(r.restored > 0);
  // ยืนยันว่าถ้าไม่กู้ (leakRadius 0) ด้านในโปร่งจริง
  const dst2 = path.join(dir, "c2-out.png");
  const r2 = await cutout(src, dst2, { leakRadius: 0 });
  assert.equal(alphaAt(dst2, 200, 200)(100, 90), 0);
  assert.equal(r2.restored, 0);
});

test("cutout: จุดเล็ก 2x2 ถูกทิ้ง", async () => {
  const src = make("d.png", [...square, [20, 170, 2, 2, DARK]]), dst = path.join(dir, "d-out.png");
  await cutout(src, dst);
  const a = alphaAt(dst, 200, 200);
  assert.equal(a(20, 170), 0);
  assert.equal(a(100, 90), 255);
});

test("cutout: ภาพ 880x1184 เร็วพอ", async () => {
  const src = make("big.png", [[200, 150, 480, 800, BROWN], [210, 160, 460, 780, CREAM], [250, 950, 400, 80, TAN]], "880x1184");
  const t = Date.now();
  await cutout(src, path.join(dir, "big-out.png"));
  assert.ok(Date.now() - t < 2000, `ช้าไป ${Date.now() - t}ms`);
});

// พื้นเขียว chroma key: ขนสีขาวที่โดนแสงเขียวสะท้อน (เขียวเกินแค่ ~40) ต้องไม่ถูกเจาะเป็นรู
const GREEN = "0x00FF00", WHITE = "0xF0F0F0", SPILL = "0xC8F0C8", SHADOW = "0x10B010";
const furry = [[50, 40, 100, 100, WHITE], [50, 110, 100, 30, SPILL], [40, 150, 120, 20, SHADOW]];

test("cutout: พื้นเขียว -> green key, ขนโดนแสงเขียวยังทึบ", async () => {
  const src = make("g.png", furry, "200x200", GREEN), dst = path.join(dir, "g-out.png");
  const r = await cutout(src, dst);
  assert.equal(r.mode, "green");
  const at = rgbaAt(dst, 200);
  assert.equal(at(2, 2)[3], 0);
  assert.equal(at(100, 160)[3], 0); // เงาเขียวเข้ม
  assert.equal(at(100, 90)[3], 255);
  assert.equal(at(100, 125)[3], 255); // กลางแถบเขียวสะท้อน ห่างจากพื้นหลัง > band
  assert.ok(at(100, 139)[3] < 255); // ขอบติดพื้นหลัง: alpha นุ่ม
  const [rr, g, b] = at(100, 125);
  assert.ok(g <= Math.max(rr, b), `despill ไม่ทำงาน: ${[rr, g, b]}`);
});

test("cutout: พื้นครีม -> flood เดิม", async () => {
  const r = await cutout(make("f.png", square), path.join(dir, "f-out.png"));
  assert.equal(r.mode, "flood");
});

test("cutout: ไม่มีไฟล์ต้นฉบับ -> VfError USAGE", async () => {
  await assert.rejects(cutout(path.join(dir, "missing.png"), path.join(dir, "x.png")), (e) => e.code === "USAGE");
});

test("cutout: เขียนปลายทางไม่ได้ -> VfError INTERNAL", async () => {
  const src = make("w.png", square);
  await assert.rejects(cutout(src, path.join(dir, "no-such-dir", "x.png")), (e) => e.code === "INTERNAL");
});
