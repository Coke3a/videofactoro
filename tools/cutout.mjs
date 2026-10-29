// ตัดพื้นหลังออกจากรูปตัวละคร/prop -> RGBA png (ffmpeg ถอดรหัส/เข้ารหัส, ที่เหลือเป็น typed array)
// พื้นเขียว chroma key -> greenKey; พื้นเรียบสีอื่น (ครีม) -> flood จากขอบ
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VfError } from "./out.mjs";

const run = promisify(execFile);
const BIG = { maxBuffer: 1 << 30, encoding: "buffer" };

async function decode(src) {
  try {
    const p = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", src]);
    const [w, h] = p.stdout.trim().split(",").map(Number);
    const { stdout } = await run("ffmpeg", ["-v", "error", "-i", src, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], BIG);
    if (!w || !h || stdout.length < w * h * 3) throw new Error("decode ไม่ครบ");
    return { w, h, px: stdout };
  } catch (e) {
    throw new VfError("USAGE", `อ่านรูปไม่ได้: ${src}`, { err: String(e.message).slice(0, 200) });
  }
}

// flood fill 4 ทิศ: queue เป็น Int32Array (แต่ละ pixel เข้าคิวได้ครั้งเดียว ผ่าน seen)
function flood(w, h, seeds, seen, ok, y0 = 0) {
  const q = new Int32Array(w * h);
  let head = 0, tail = 0;
  for (const i of seeds) if (!seen[i]) { seen[i] = 1; q[tail++] = i; }
  while (head < tail) {
    const i = q[head++];
    if (!ok(i)) continue;
    const x = i % w, y = (i - x) / w;
    if (x > 0 && !seen[i - 1]) { seen[i - 1] = 1; q[tail++] = i - 1; }
    if (x < w - 1 && !seen[i + 1]) { seen[i + 1] = 1; q[tail++] = i + 1; }
    if (y > y0 && !seen[i - w]) { seen[i - w] = 1; q[tail++] = i - w; }
    if (y < h - 1 && !seen[i + w]) { seen[i + w] = 1; q[tail++] = i + w; }
  }
}

function borderIdx(w, h) {
  const a = [];
  for (let x = 0; x < w; x++) a.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) a.push(y * w, y * w + w - 1);
  return a;
}

// min/max filter แบบแยกแกนขนาด (2r+1)^2; นอกภาพนับเป็น `out`
function boxFilter(m, w, h, r, isMin, out) {
  const tmp = new Uint8Array(w * h), res = new Uint8Array(w * h);
  const pick = (a, b) => (isMin ? a & b : a | b);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = isMin ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        v = pick(v, xx < 0 || xx >= w ? out : m[y * w + xx]);
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = isMin ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        v = pick(v, yy < 0 || yy >= h ? out : tmp[yy * w + x]);
      }
      res[y * w + x] = v;
    }
  }
  return res;
}

// ทิ้งเกาะทึบเล็ก ๆ (เศษกระดาษ/เศษเงา)
function dropIslands(alpha, w, h, minPx) {
  const n = w * h, comp = new Uint8Array(n), q = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!alpha[s] || comp[s]) continue;
    let head = 0, tail = 0;
    q[tail++] = s; comp[s] = 1;
    while (head < tail) {
      const i = q[head++], x = i % w;
      if (x > 0 && alpha[i - 1] && !comp[i - 1]) { comp[i - 1] = 1; q[tail++] = i - 1; }
      if (x < w - 1 && alpha[i + 1] && !comp[i + 1]) { comp[i + 1] = 1; q[tail++] = i + 1; }
      if (i >= w && alpha[i - w] && !comp[i - w]) { comp[i - w] = 1; q[tail++] = i - w; }
      if (i < n - w && alpha[i + w] && !comp[i + w]) { comp[i + w] = 1; q[tail++] = i + w; }
    }
    if (tail < minPx) for (let k = 0; k < tail; k++) alpha[q[k]] = 0;
  }
}

const greenExcess = (px, i) => px[i * 3 + 1] - Math.max(px[i * 3], px[i * 3 + 2]);

// ขอบรูปเกือบทั้งหมดเป็นเขียวจัด = ภาพสั่งพื้น chroma key มา
export function isGreenBg(w, h, px, hi = 70) {
  const b = borderIdx(w, h);
  return b.filter((i) => greenExcess(px, i) >= hi).length >= b.length * 0.9;
}

// แกน = เขียวจัด (>= hi) ที่ต่อกับขอบรูป -> โปร่ง; แถบ band px ถัดจากแกนที่ยังเขียวเกิน lo -> alpha นุ่ม
// ไม่ไหลผ่านพิกเซลเขียวอ่อน ขนขาวที่โดนแสงเขียวสะท้อนกลางตัวจึงไม่เป็นรู
function greenKey(w, h, px, alpha, { lo = 25, hi = 70, band = 3 } = {}) {
  const n = w * h, d = new Uint8Array(n).fill(255), q = new Int32Array(n);
  let head = 0, tail = 0;
  const core = (i) => { if (d[i] === 255 && greenExcess(px, i) >= hi) { d[i] = 0; q[tail++] = i; } };
  for (const i of borderIdx(w, h)) core(i);
  while (head < tail) {
    const i = q[head++], x = i % w;
    if (x > 0) core(i - 1);
    if (x < w - 1) core(i + 1);
    if (i >= w) core(i - w);
    if (i < n - w) core(i + w);
  }
  head = 0;
  while (head < tail) {
    const i = q[head++], x = i % w;
    if (d[i] >= band) continue;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= n || d[j] !== 255 || greenExcess(px, j) <= lo) continue;
      d[j] = d[i] + 1; q[tail++] = j;
    }
  }
  for (let i = 0; i < n; i++) {
    if (d[i] === 0) alpha[i] = 0;
    else if (d[i] !== 255) alpha[i] = Math.round(255 * Math.min(1, (hi - greenExcess(px, i)) / (hi - lo)));
  }
  // despill: ตัดเขียวส่วนเกินทั้งภาพ (แสงเขียวสะท้อนบนขน)
  for (let i = 0; i < n; i++) if (greenExcess(px, i) > 0) px[i * 3 + 1] = Math.max(px[i * 3], px[i * 3 + 2]);
}

export async function cutout(src, dst, { tol = 30, shadowTol = 190, islandFrac = 1 / 400, leakRadius = 4 } = {}) {
  const { w, h, px } = await decode(src);
  const n = w * h;
  const alpha = new Uint8Array(n).fill(255);
  let restored = 0, mode = "flood";
  if (isGreenBg(w, h, px)) {
    mode = "green";
    greenKey(w, h, px, alpha);
    dropIslands(alpha, w, h, Math.floor(n * islandFrac));
  } else restored = floodCut(w, h, px, alpha, { tol, shadowTol, islandFrac, leakRadius });

  const rgba = Buffer.alloc(n * 4);
  let clear = 0;
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = px[i * 3]; rgba[i * 4 + 1] = px[i * 3 + 1]; rgba[i * 4 + 2] = px[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
    if (!alpha[i]) clear++;
  }
  await new Promise((res, rej) => {
    const p = execFile("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-i", "-", "-frames:v", "1", dst],
      (e) => (e ? rej(new VfError("INTERNAL", `เขียน PNG ไม่ได้: ${dst}`, { err: String(e.message).slice(0, 200) })) : res()));
    p.stdin.end(rgba);
  });
  return { w, h, transparent: clear / n, restored, mode };
}

// พื้นเรียบ (ครีม): คืนจำนวนพิกเซลที่กู้คืนจากรูรั่ว
function floodCut(w, h, px, alpha, { tol, shadowTol, islandFrac, leakRadius }) {
  const n = w * h;
  const bg = [px[0], px[1], px[2]], bgSum = bg[0] + bg[1] + bg[2];
  const dist = (i) => Math.abs(px[i * 3] - bg[0]) + Math.abs(px[i * 3 + 1] - bg[1]) + Math.abs(px[i * 3 + 2] - bg[2]);

  // 1) พื้นหลังจากขอบรูป
  const seen = new Uint8Array(n);
  flood(w, h, borderIdx(w, h), seen, (i) => {
    if (dist(i) > tol) return false;
    alpha[i] = 0;
    return true;
  });

  // 2) เงาพื้น: เข้มกว่ากระดาษ อยู่ครึ่งล่าง ต่อกับพื้นหลังที่ลบแล้ว (shadowTol เป็น 0 = ปิด)
  if (shadowTol) {
    const y0 = Math.floor(h * 0.62);
    const seeds = [];
    for (let i = y0 * w; i < n; i++) if (alpha[i] === 0) seeds.push(i);
    flood(w, h, seeds, new Uint8Array(n), (i) => {
      if (alpha[i]) {
        const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2], d = dist(i);
        // ครีมในตัวที่ผ่าน 1 ไม่ถึง (d <= tol) ไม่ใช่เงา
        if (d > shadowTol || d <= tol || r + g + b >= bgSum || Math.min(r, g, b) < 120) return false;
        alpha[i] = 0;
      }
      return true;
    }, y0);
  }

  // 3) ทิ้งเกาะทึบเล็ก ๆ
  dropIslands(alpha, w, h, Math.floor(n * islandFrac));

  // 4) กู้ส่วนที่รั่ว: โปร่งที่ถึงจากขอบได้เฉพาะผ่านช่องแคบ (< ~2*leakRadius px) ให้กลับเป็นทึบ
  let restored = 0;
  if (leakRadius > 0) {
    const tr = new Uint8Array(n);
    for (let i = 0; i < n; i++) tr[i] = alpha[i] ? 0 : 1;
    const eroded = boxFilter(tr, w, h, leakRadius, true, 1);
    const reached = new Uint8Array(n);
    flood(w, h, borderIdx(w, h).filter((i) => eroded[i]), reached, (i) => eroded[i] === 1);
    // seed ที่ไม่ใช่ eroded ถูก mark seen แล้ว จึงล้างทิ้งก่อน dilate
    for (let i = 0; i < n; i++) if (!eroded[i]) reached[i] = 0;
    const keep = boxFilter(reached, w, h, leakRadius, false, 0);
    for (let i = 0; i < n; i++) if (tr[i] && !keep[i]) { alpha[i] = 255; restored++; }
  }
  return restored;
}
