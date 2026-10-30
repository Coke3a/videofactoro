// แผนฉาก + เสียงที่วัดแล้ว → index.html ของ HyperFrames (GSAP timeline เดียว) และรายการเสียง
// ฟังก์ชันบริสุทธิ์: ไม่สุ่ม ไม่อ่านเวลา อินพุตเดิม → HTML เดิมทุกไบต์
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { VfError } from "./out.mjs";
import { LEAD, GAP, TAIL, SCENE_MIN } from "./motion-plan.mjs";
import { spotX } from "./stage.mjs";
import { narrationBudget } from "./clip.mjs";

const KIT_CSS = new URL("./hf-kit/base.css", import.meta.url);
const SPRITE_RATIO = 1184 / 880; // ขนาดจริงของภาพท่า 3:4 จากโมเดล
// เล็กลงจาก 0.5/0.3: ตัวใหญ่บังเฟอร์นิเจอร์ครึ่งห้องจนดูเหมือนยืนบนโต๊ะ และหัวชนคำบรรยาย
export const ACTOR_SIZE = 0.42;
// ฉาก 3 ตัว: 0.42 × 3 กว้างเกินเฟรม → ย่อลงให้วางห่างกันได้ครบในเฟรม
export const CROWD_SIZE = 0.34;
const PROP_SIZE = 0.26;
// prop ที่ไม่บอกข้อมูล = ภาพจากโมเดล 1:1 ตั้งบนพื้น (พฤติกรรมเดิม)
const PROP_DEFAULT = { placement: "upright", size_cm: null, aspect: 1, trimmed: false };
// ตัวละครขนาดมาตรฐานถือว่าสูง 160 ซม.: ส่วนที่เห็นจริงในภาพท่า ≈ 73% ของความสูงภาพ (เว้นใต้เท้า 19% เหนือหัว ~8%)
const CHAR_CM = 160;
const W_PER_CM = (ACTOR_SIZE * SPRITE_RATIO * 0.73) / CHAR_CM;
const FLOOR_TILT = 72;
const FLOOR_PERSPECTIVE = 1400;
// ระยะกึ่งกลางขั้นต่ำ = SEP × ความกว้างเฉลี่ยของคู่: ตัวละครจริงกินแค่ ~78% ของกว้างภาพท่า (ขอบใส)
export const SEP = 0.8;
const RIDE_BOTTOM = "30%";
const SPRITE_FOOT = 0.19;
const CAP_BOTTOM = 0.43;
// ซูมทั้งฉาก (ฉากหลัง + ตัวละคร + prop) รอบระดับเท้า: ตัวใหญ่ขึ้นโดยสัดส่วนกับห้องไม่เพี้ยน
// ลดซูมลงจนทุกชิ้นยังอยู่ในเฟรม และหาจุดยึดแนวนอนที่ไม่ดันชิ้นไหนหลุดขอบ
const ZOOM_STEP = 0.05;
const ZOOM_MARGIN = 0.02;
const CAP_LOW = 0.1;
const CAP_HIGH = 0.72;
export const MEDIUM_ZOOM = 1.35;
export const CLOSE_ZOOM = 2;
// close: หน้าไปอยู่ที่ 36% จากบน · low: เท้าไปอยู่ที่ 66% จากบน (เห็นพื้นและของที่ยืนอยู่)
const SHOT_AIM = { close: ["face", 0.36], low: ["feet", 0.66] };

// มุมกล้องของฉาก → transform ของ .world (origin 0 0): x' = x·z + tx
// wide/medium = worldZoom รอบระดับเท้า (medium ซูมเพิ่มให้พอดีตัวละคร) · close/low = เล็งจุดบนตัวละครที่ focus
export function shotView({ shot = "wide", zoom = 1, W, H, feetPx, extents, focus }) {
  const aim = SHOT_AIM[shot];
  if (aim && focus) {
    const z = Math.max(CLOSE_ZOOM, zoom);
    const [mark, at] = aim;
    // ขอบ world ต้องคลุมเฟรมเสมอ: tx ∈ [W(1−z), 0]
    const tx = Math.min(0, Math.max(W * (1 - z), W / 2 - focus.x * z));
    const ty = Math.min(0, Math.max(H * (1 - z), H * at - focus[mark] * z));
    return { z, tx: r3(tx), ty: r3(ty), tight: true };
  }
  const v = worldZoom({ zoom: shot === "medium" ? Math.max(zoom, 1) * MEDIUM_ZOOM : zoom, W, extents });
  const oy = H - feetPx;
  return { z: v.z, tx: r3(v.ox * (1 - v.z)), ty: r3(oy * (1 - v.z)), tight: false };
}

export function worldZoom({ zoom = 1, W, extents }) {
  if (!(zoom > 1) || !extents.length) return { z: 1, ox: W / 2 };
  const lo = Math.min(...extents.map((e) => e[0]));
  const hi = Math.max(...extents.map((e) => e[1]));
  const m = W * ZOOM_MARGIN;
  for (let z = Math.min(zoom, 3); z > 1 + 1e-9; z -= ZOOM_STEP) {
    // จุด x หลังซูม = ox + (x − ox)·z → ต้องการ lo' ≥ m และ hi' ≤ W − m
    const min = (hi * z - (W - m)) / (z - 1);
    const max = (lo * z - m) / (z - 1);
    const a = Math.max(0, min), b = Math.min(W, max);
    if (a <= b) return { z: r3(z), ox: Math.min(b, Math.max(a, (lo + hi) / 2)) };
  }
  return { z: 1, ox: W / 2 };
}
const NARRATOR_COLOR = "#ffffff";
// สีอิ่มตัว ตัดกับขอบดำ: สีพาสเทล (#ffb36b เดิม) จมไปกับ plate สีครีม
const CAP_COLORS = ["#ffd60a", "#3ad7ff", "#6dff4f", "#ff5fa8", "#ff8c1a"];
const MOVE_DUR = { to: 1.2, "run-to": 1.2, shiver: 2, loop: 3 };
const CHUNK_MIN = 4;
const CHUNK_MAX = 8;

const r3 = (v) => Math.round(v * 1000) / 1000;
const uniq = (xs) => [...new Set(xs)];
const json = (v) => JSON.stringify(v);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// id จากแผน (LLM) → ใช้เป็น DOM id/selector ได้ปลอดภัย
const safe = (s) => String(s).replace(/[^A-Za-z0-9-]/gu, (c) => `_${c.codePointAt(0).toString(16)}`);
const spaced = (lang) => narrationBudget(lang, 1).unit === "คำ";

const NOTO = "/usr/share/fonts/truetype/noto";
export function FONT_FOR(lang) {
  if (/^th/i.test(String(lang ?? ""))) {
    return {
      // Loma มีตัวละตินด้วย (stamp อย่าง BONK! ในคลิปไทย) และมีในเครื่องจริงอยู่แล้วสำหรับ ASS ของ longform
      family: "Loma",
      candidates: ["/usr/share/fonts/opentype/tlwg/Loma-Bold.otf", "/usr/share/fonts/truetype/tlwg/Loma-Bold.ttf", `${NOTO}/NotoSansThai-Bold.ttf`],
    };
  }
  return { family: "Noto Sans", candidates: [`${NOTO}/NotoSans-Bold.ttf`] };
}

export function fontFile(lang) {
  const env = process.env.VF_HF_FONT;
  if (env) {
    if (!existsSync(env)) throw new VfError("CONFIG", `ไม่พบไฟล์ฟอนต์ตาม VF_HF_FONT: ${env}`);
    return env;
  }
  const f = FONT_FOR(lang);
  const hit = f.candidates.find((c) => existsSync(c));
  if (hit) return hit;
  const pkg = /^th/i.test(String(lang ?? "")) ? "fonts-thai-tlwg (หรือ fonts-noto-core)" : "fonts-noto-core";
  throw new VfError("CONFIG", `ไม่พบฟอนต์คำบรรยาย ${f.family}: ติดตั้งแพ็กเกจ ${pkg} หรือตั้ง VF_HF_FONT เป็นไฟล์ฟอนต์`, { candidates: f.candidates });
}

// เวลาแต่ละฉาก: lead + บท (คั่น gap) + tail ขั้นต่ำ SCENE_MIN; เวลาบทนับจากต้นฉาก
export function sceneTimes(plan, lines) {
  let t0 = 0;
  return plan.scenes.map((sc, si) => {
    let cur = LEAD;
    const ls = (sc.lines ?? []).map((l, li) => {
      const key = `${si + 1}-${li + 1}`;
      const secs = lines?.[key]?.seconds;
      if (!(Number.isFinite(secs) && secs >= 0)) throw new VfError("INTERNAL", `ไม่มีความยาวเสียงของบท ${key}`);
      const start = r3(cur);
      const end = r3(cur + secs);
      cur = end + GAP;
      return { key, who: l.who, start, end };
    });
    const dur = r3(Math.max(SCENE_MIN, ls.length ? ls.at(-1).end + TAIL : 0));
    const out = { id: sc.id, start: t0, dur, lines: ls };
    t0 = r3(t0 + dur);
    return out;
  });
}

// ปากเปิดเมื่อดังกว่า 0.3 × max; เปิดติดกันเกิน 4 เฟรมให้ปิดหนึ่งเฟรม (ดูเหมือนพูดเป็นพยางค์)
export function mouthFrames(rms) {
  const v = (Array.isArray(rms) ? rms : []).map((x) => (Number.isFinite(x) ? x : 0));
  const max = v.reduce((m, x) => Math.max(m, x), 0);
  if (!(max > 0)) return v.map(() => false);
  const thr = max * 0.3;
  let run = 0;
  return v.map((x) => {
    let o = x > thr;
    run = o ? run + 1 : 0;
    if (run > 4) { o = false; run = 0; }
    return o;
  });
}

// ภาษาที่เว้นวรรค → ทีละคำ; ไทย ฯลฯ → ตัดคำด้วย Intl.Segmenter แล้วรวมเป็นช่วงสั้น 4–8 ตัวอักษร
export function captionChunks(text, lang) {
  const parts = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (spaced(lang)) return parts;
  const seg = new Intl.Segmenter(String(lang || "th"), { granularity: "word" });
  const out = [];
  for (const part of parts) {
    let cur = "";
    for (const { segment, isWordLike } of seg.segment(part)) {
      const len = [...cur].length;
      if (cur && isWordLike && (len >= CHUNK_MIN || len + [...segment].length > CHUNK_MAX)) {
        out.push(cur);
        cur = "";
      }
      cur += segment;
    }
    if (cur) out.push(cur);
  }
  return out;
}

function atSec(at, lines) {
  if (typeof at === "number" && Number.isFinite(at)) return at;
  const s = String(at ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^line(\d+)(-end)?$/.exec(s);
  const l = m && lines[Number(m[1]) - 1];
  if (!l) throw new VfError("INTERNAL", `เวลา beat ไม่ถูกต้อง: ${s}`);
  return m[2] ? l.end : l.start;
}

// ท่าของตัวละครแต่ละตัว ณ เวลา sec จากต้นฉาก (ท่าใน cast แล้วไล่ beat ที่เปลี่ยนท่าตามเวลา)
export function poseAt(sc, t, sec) {
  const pose = Object.fromEntries((sc.cast ?? []).map((c) => [c.who, c.pose]));
  const beats = (sc.beats ?? []).filter((b) => b.pose && b.who in pose).map((b) => ({ ...b, at: beatAt(b, t) })).sort(byAt);
  for (const b of beats) if (b.at <= sec) pose[b.who] = b.pose;
  return pose;
}

// เวลา beat ถูกบีบไว้ในช่วงฉาก → tween และ sfx ไม่ล้นไปฉากถัดไป
const beatAt = (b, t) => Math.min(t.dur, Math.max(0, atSec(b.at, t.lines)));

const byAt = (a, b) => a.at - b.at;

const inFrame = (x, w) => Math.min(1 - w / 2, Math.max(w / 2, x));

// items: [{ key, x, w }] เป็นสัดส่วนของความกว้างเฟรม → { key: x } ที่อยู่ในเฟรมเต็มตัวและห่างกันอย่างน้อย SEP
// ดันไปทางขวาก่อน แล้วดันกลับจากขอบขวา; ยังไม่พอ (ตัวใหญ่เกิน) → กระจายเท่า ๆ กัน
export function layoutX(items) {
  const xs = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.x - b.x || a.i - b.i);
  for (const it of xs) it.x = inFrame(it.x, it.w);
  const gap = (a, b) => (SEP * (a.w + b.w)) / 2;
  for (let k = 1; k < xs.length; k++) xs[k].x = Math.max(xs[k].x, xs[k - 1].x + gap(xs[k - 1], xs[k]));
  for (let k = xs.length - 1; k >= 0; k--) {
    const hi = k + 1 < xs.length ? xs[k + 1].x - gap(xs[k], xs[k + 1]) : 1 - xs[k].w / 2;
    xs[k].x = Math.min(xs[k].x, hi);
  }
  if (xs.some((it) => it.x < it.w / 2 - 1e-9)) {
    const lo = xs[0].w / 2;
    const hi = 1 - xs.at(-1).w / 2;
    xs.forEach((it, k) => { it.x = inFrame(xs.length > 1 ? lo + (k * (hi - lo)) / (xs.length - 1) : 0.5, it.w); });
  }
  return Object.fromEntries(xs.map((it) => [it.key, r3(it.x)]));
}

export function audioCues(plan, times) {
  const voices = [];
  const sfx = [];
  plan.scenes.forEach((sc, si) => {
    const t = times[si];
    for (const l of t.lines) voices.push({ file: `voice-${l.key}.wav`, at: r3(t.start + l.start) });
    for (const b of sc.beats ?? []) if (b.sfx) sfx.push({ kind: b.sfx, at: r3(t.start + beatAt(b, t)) });
  });
  return { voices: voices.sort(byAt), sfx: sfx.sort(byAt) };
}

function speakerColors(plan) {
  const m = Object.create(null);
  m.narrator = NARRATOR_COLOR;
  let i = 0;
  for (const sc of plan.scenes) for (const l of sc.lines ?? []) {
    if (!Object.hasOwn(m, l.who)) m[l.who] = CAP_COLORS[i++ % CAP_COLORS.length];
  }
  return m;
}

const CAMERA = {
  push: (d) => [{ scale: 1 }, { scale: 1.08, duration: d, ease: "none" }],
  "push-fast": (d) => [{ scale: 1.02 }, { scale: 1.2, duration: d, ease: "power2.in" }],
  "pan-left": (d, X) => [{ x: X(50) }, { x: X(-50), duration: d, ease: "sine.inOut" }],
  "pan-right": (d, X) => [{ x: X(-50) }, { x: X(50), duration: d, ease: "sine.inOut" }],
};

const defaultFont = (lang) => {
  const f = FONT_FOR(lang);
  return { family: f.family, file: basename(f.candidates[0]) };
};

// font: { family, file } — file คือชื่อไฟล์ใน fonts/ ของโฟลเดอร์ render (ค่าเริ่มต้นจาก FONT_FOR)
export function composeHtml({ plan, times, lines = {}, stage, assets, size = { w: 1080, h: 1920 }, fps = 30, lang = "en", font, zoom = 1 }) {
  const W = size.w;
  const H = size.h;
  // ค่าพิกเซลในชุดท่าทางอ้างอิงเฟรม 1080×1920
  const X = (v) => r3((v * W) / 1080);
  const Y = (v) => r3((v * H) / 1920);
  const f = font ?? defaultFont(lang);
  const family = String(f.family).replace(/["\\<>\n\r]/g, "");
  const colors = speakerColors(plan);
  const css = readFileSync(KIT_CSS, "utf8").trim();
  if (!Array.isArray(times) || times.length !== plan.scenes.length) throw new VfError("INTERNAL", "times ไม่ตรงกับจำนวนฉาก");

  const html = [];
  const js = [];
  const tweened = new Set();
  // กติกา lint: tween แรกของ element render ทันที ตัวถัดไปต้อง immediateRender:false
  const tw = (sel, from, to, at) => {
    const opts = tweened.has(sel) ? { ...to, immediateRender: false } : to;
    tweened.add(sel);
    js.push(`tl.fromTo(${json(sel)}, ${json(from)}, ${json(opts)}, ${r3(at)});`);
  };
  const set = (sel, vars, at) => js.push(`tl.set(${json(sel)}, ${json(vars)}, ${r3(at)});`);

  // ภาษาไม่เว้นวรรค (ไทย): ช่วงที่ตัดด้วย Segmenter ต้องติดกัน เว้นเฉพาะตรงที่ต้นฉบับมีช่องว่าง
  const makeCaps = (sc, t, eid, capAt) => t.lines.map((l, i) => {
    const text = sc.lines[i].text;
    const words = captionChunks(text, lang);
    const id = eid(`cap${i + 1}`);
    const tight = !spaced(lang);
    const starts = new Set();
    if (tight) {
      let k = 0;
      String(text ?? "").trim().split(/\s+/).filter(Boolean).forEach((part, pi) => {
        if (pi > 0) starts.add(k);
        k += captionChunks(part, lang).length;
      });
    }
    const spans = words.map((w, wi) => `<span${starts.has(wi) ? ' class="g"' : ""}>${esc(w)}</span>`).join("");
    return { id, words, html: `<div id="${id}" class="cap${tight ? " tight" : ""}" style="color:${colors[l.who] ?? NARRATOR_COLOR}${capAt}">${spans}</div>` };
  });
  const capTweens = (caps, t, T) => t.lines.forEach((l, i) => {
    const c = caps[i];
    tw(`#${c.id} span`, { opacity: 0, y: Y(20) }, { opacity: 1, y: 0, duration: 0.12, stagger: r3((l.end - l.start) / Math.max(1, c.words.length)) }, T(l.start));
    tw(`#${c.id}`, { opacity: 1 }, { opacity: 0, duration: 0.15 }, T(Math.min(t.dur - 0.15, l.end + 0.25)));
  });

  // insert = รูปสินค้าจริงเต็มจอ ซูมช้า + ป้าย · endcard = hero + ชื่อ + ราคา + ชวนซื้อ
  // รูปจริงแสดงทั้งรูปเสมอ (contain) ไม่ครอป ไม่บิด: สินค้าต้องเห็นครบเหมือนในร้าน
  const cardScene = (sc, t, sid, eid, T) => {
    const pr = assets.product ?? {};
    const imgOf = (id) => {
      const im = assets.productImage?.(id);
      if (!im) throw new VfError("INTERNAL", `ไม่มีรูปสินค้า ${id}`);
      return im;
    };
    const fit = (im, bw, bh) => {
      const k = Math.min(bw / im.w, bh / im.h);
      return { w: r3(im.w * k), h: r3(im.h * k) };
    };
    const photo = (id, im, box, cy) => {
      const { w, h } = fit(im, box.w, box.h);
      const cls = im.cutout ? "card-photo cutout" : "card-photo framed";
      return {
        w, h, top: r3(cy - h / 2),
        html: `<div id="${id}" class="${cls}" style="left:${r3((W - w) / 2)}px;top:${r3(cy - h / 2)}px;width:${w}px;height:${h}px"><img id="${id}-img" src="${esc(im.src)}" /></div>`,
      };
    };
    const caps = makeCaps(sc, t, eid, `;bottom:${r3((sc.kind === "endcard" ? 0.05 : CAP_LOW) * H)}px`);
    const parts = [];
    if (sc.kind === "insert") {
      const im = imgOf(sc.image);
      const ph = photo(eid("photo"), im, { w: W * 0.86, h: H * 0.6 }, H * 0.42);
      parts.push(ph.html);
      const chip = typeof sc.chip === "string" ? sc.chip.trim() : "";
      if (chip) parts.push(`<div id="${eid("chip")}" class="chip" style="top:${r3(ph.top + ph.h + Y(40))}px">${esc(chip)}</div>`);
      tw(`#${eid("photo")}`, { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.35, ease: "power2.out" }, T(0));
      // ซูมช้าทั้งฉาก (Ken Burns) ให้ภาพนิ่งมีชีวิต
      tw(`#${eid("photo")}-img`, { scale: 1 }, { scale: 1.07, duration: t.dur, ease: "none" }, T(0));
      if (chip) tw(`#${eid("chip")}`, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2.5)" }, T(0.45));
    } else {
      const hero = assets.product?.images?.find((x) => x.role === "hero");
      if (!hero) throw new VfError("INTERNAL", "endcard ต้องมีรูป hero");
      const ph = photo(eid("photo"), imgOf(hero.id), { w: W * 0.8, h: H * 0.4 }, H * 0.28);
      const y0 = ph.top + ph.h + Y(50);
      parts.push(ph.html);
      parts.push(`<div id="${eid("name")}" class="end-name" style="top:${r3(y0)}px">${esc(pr.name)}</div>`);
      // ชื่อยาวขึ้นได้ 2 บรรทัด (66px × 1.2) → ราคาเริ่มใต้ 2 บรรทัดเสมอ
      const price = pr.show_price && pr.price_text;
      if (price) parts.push(`<div id="${eid("price")}" class="end-price" style="top:${r3(y0 + Y(190))}px">${esc(pr.price_text)}</div>`);
      if (pr.cta) parts.push(`<div id="${eid("cta")}" class="end-cta" style="top:${r3(y0 + Y(price ? 420 : 190))}px"><span>${esc(pr.cta)}</span></div>`);
      tw(`#${eid("photo")}`, { opacity: 0, y: Y(60) }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, T(0));
      tw(`#${eid("name")}`, { opacity: 0, y: Y(30) }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }, T(0.25));
      if (price) tw(`#${eid("price")}`, { opacity: 0, scale: 2.2 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, T(0.5));
      // ป้ายนิ่ง ไม่เต้นเรียกให้กด (soft sell)
      if (pr.cta) tw(`#${eid("cta")}`, { opacity: 0, y: Y(40) }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }, T(price ? 0.8 : 0.5));
    }
    html.push([
      `<section id="${sid}" class="clip card" data-start="${r3(t.start)}" data-duration="${t.dur}" data-track-index="1">`,
      ...parts,
      ...caps.map((c) => c.html),
      "</section>",
    ].join("\n    "));
    capTweens(caps, t, T);
  };

  plan.scenes.forEach((sc, si) => {
    const t = times[si];
    const sid = `sc${si + 1}`;
    const eid = (k) => `${sid}-${k}`;
    const T = (s) => t.start + s;
    if (sc.kind === "insert" || sc.kind === "endcard") return cardScene(sc, t, sid, eid, T);
    const st = stage?.[sc.place];
    if (!st) throw new VfError("INTERNAL", `ไม่มี stage ของสถานที่ ${sc.place}`);
    const floorPx = (1 - st.floor) * H;
    const cast = sc.cast ?? [];
    const props = sc.props ?? [];
    const beats = sc.beats ?? [];

    const actorW = (c) => c.size ?? (cast.length >= 3 ? CROWD_SIZE : ACTOR_SIZE);
    // ขอบล่างกล่องตัวละคร: เท้าอยู่ที่ floor + 13% ของความสูงภาพ · ที่ว่างใต้เท้าเดิมถือว่า 19% ทุกท่า
    // assets.spriteFoot(who, pose) = ที่ว่างที่วัดจากภาพจริง (ท่าวิดพื้นมีมากกว่าท่ายืนมาก)
    const boxBottom = (c, ah) => floorPx + ah * (0.13 - (assets.spriteFoot?.(c.who, c.pose) ?? SPRITE_FOOT));
    const byId = Object.fromEntries(props.map((p) => [p.id, p]));
    const info = (p) => ({ ...PROP_DEFAULT, ...(assets.propInfo?.(p.id) ?? {}) });
    const flat = (p) => info(p).placement === "floor";
    // ขนาดจริง (size_cm) ชนะ size ที่ LLM เดา: สินค้าต้องดูใหญ่เท่าของจริงเมื่อเทียบกับตัวละคร
    const realW = (p) => {
      const i = info(p);
      if (!i.size_cm) return null;
      const long = i.size_cm * W_PER_CM;
      return Math.min(0.95, flat(p) || i.aspect >= 1 ? long : long * i.aspect);
    };
    const propW = (p) => realW(p) ?? p.size ?? PROP_SIZE;
    const propIds = new Set(props.map((p) => p.id));
    // ขี่ prop ที่ตั้งบนพื้น = อยู่ในกล่องของ prop · ยืนบน prop ที่ปูพื้น (onMat) = ยืนบนพื้นตรงจุดของ prop
    const rides = (c) => c.ride && propIds.has(c.ride) && !flat(byId[c.ride]);
    const onMat = (c) => c.ride && propIds.has(c.ride) && flat(byId[c.ride]);
    // จัดตำแหน่งตัวที่ยืนบนพื้น + prop ที่มีคนขี่ (กว้างเท่าตัวที่ขี่) ด้วยกัน; prop เปล่าแค่ไม่ให้หลุดขอบ
    const riders = (p) => cast.filter((c) => (rides(c) || onMat(c)) && c.ride === p.id);
    const bodyW = (p) => Math.max(propW(p), ...riders(p).map(actorW));
    const pos = layoutX([
      ...cast.filter((c) => !rides(c) && !onMat(c)).map((c) => ({ key: `c:${c.who}`, x: spotX(st, c.spot), w: actorW(c) })),
      ...props.filter((p) => riders(p).length).map((p) => ({ key: `o:${p.id}`, x: spotX(st, p.spot), w: bodyW(p) })),
    ]);
    const propX = Object.fromEntries(props.map((p) => [p.id, pos[`o:${p.id}`] ?? inFrame(spotX(st, p.spot), propW(p))]));
    // who ใน beat: หาใน cast ก่อน แล้วค่อย props (cast ทับ props)
    const el = Object.create(null);
    for (const p of props) el[p.id] = { sel: `#${eid(`o-${safe(p.id)}`)}`, x0: propX[p.id], w: bodyW(p), body: false, cur: 0 };
    // ตัวที่ขี่/ยืนบน prop → ระยะเดินนับจากจุดของ prop
    for (const c of cast) el[c.who] = { sel: `#${eid(`c-${safe(c.who)}`)}`, x0: rides(c) || onMat(c) ? propX[c.ride] : pos[`c:${c.who}`], w: actorW(c), body: true, cur: 0 };

    const posesOf = (c) => uniq([c.pose, ...beats.filter((b) => b.who === c.who && b.pose).map((b) => b.pose)]);
    const actorHtml = (c) => {
      const aw = actorW(c) * W;
      const ah = aw * SPRITE_RATIO;
      const id = eid(`c-${safe(c.who)}`);
      const imgs = posesOf(c).flatMap((p) => [
        `<img id="${id}-p-${safe(p)}" class="sprite" src="${esc(assets.sprite(c.who, p, false))}" />`,
        `<img id="${id}-t-${safe(p)}" class="sprite" src="${esc(assets.sprite(c.who, p, true))}" />`,
      ]).join("");
      const at = rides(c)
        // ภาพท่ามีที่ว่างใต้เท้า ~19% → จมลงในยอด prop นิดหน่อยให้ดูนั่งอยู่จริง ไม่ลอย
        ? `left:50%;margin-left:${r3(-aw / 2)}px;bottom:${RIDE_BOTTOM}`
        : `left:${r3(el[c.who].x0 * W - aw / 2)}px;bottom:${r3(boxBottom(c, ah))}px`;
      return `<div id="${id}" class="actor" style="${at};width:${r3(aw)}px;height:${r3(ah)}px"><div id="${id}-body" class="body">${imgs}</div></div>`;
    };
    // ระดับเท้าของตัวละครขนาดมาตรฐาน (ขอบล่างกล่อง −6% + ที่ว่างใต้เท้า 19%)
    const feetPx = floorPx + ACTOR_SIZE * W * SPRITE_RATIO * 0.13;
    const propHtml = (p) => {
      const i = info(p);
      const pw = propW(p) * W;
      const ph = pw / i.aspect;
      const ride = riders(p).filter(rides).map(actorHtml).join("");
      const left = r3(propX[p.id] * W - pw / 2);
      const img = `<img class="prop-img" src="${esc(assets.prop(p.id))}" />`;
      if (flat(p)) {
        // ปูพื้น: เอียงภาพลงนอน (ขอบล่างอยู่กับที่) ให้กลางผืนอยู่ระดับเท้า ตัวละครจึงยืนอยู่บนผืน
        const seen = ph * Math.cos((FLOOR_TILT * Math.PI) / 180);
        return `<div id="${eid(`o-${safe(p.id)}`)}" class="prop" style="left:${left}px;bottom:${r3(feetPx - seen / 2)}px;width:${r3(pw)}px;height:${r3(ph)}px">`
          + `<div class="prop-flat" style="transform:perspective(${FLOOR_PERSPECTIVE}px) rotateX(${FLOOR_TILT}deg)">${img}</div></div>`;
      }
      // รูปจริงที่ตัดขอบใสแล้ว (trimmed) วางบนระดับเท้าพอดี · ภาพจาก prompt มีขอบใสรอบวัตถุ จึงจมลงนิดหน่อยแบบเดิม
      const bottom = i.trimmed ? feetPx : floorPx - pw * 0.12;
      return `<div id="${eid(`o-${safe(p.id)}`)}" class="prop" style="left:${left}px;bottom:${r3(bottom)}px;width:${r3(pw)}px;height:${r3(ph)}px">`
        + `${img}${ride}</div>`;
    };
    // พิกัดจากขอบบนของจุดสำคัญของตัวละคร (ใช้เล็งกล้อง close/low และวางคำบรรยาย)
    const marks = (c) => {
      const ah = actorW(c) * W * SPRITE_RATIO;
      const box = boxBottom(c, ah);
      return { x: el[c.who].x0 * W, face: H - (box + ah * 0.8), feet: H - (box + ah * 0.19), head: H - (box + ah * 0.92) };
    };
    const ext = (e) => [(e.x0 - e.w / 2) * W, (e.x0 + e.w / 2) * W];
    const focusC = cast.find((c) => c.who === sc.focus) ?? cast[0];
    const view = shotView({
      shot: sc.shot, zoom, W, H, feetPx,
      extents: (sc.shot === "medium" ? cast.map((c) => el[c.who]) : Object.values(el)).map(ext),
      focus: focusC && marks(focusC),
    });
    // คำบรรยายลอยเหนือหัวเสมอ: ซูมแล้วหัวสูงขึ้นตาม จึงยกคำบรรยายตาม (ค่าเดิม 43% ใน base.css)
    // close/low หัวหลุดเฟรมหรือเต็มจอ → คำบรรยายไปอยู่ล่างจอ
    const heads = cast.filter((c) => !rides(c)).map((c) => marks(c).head);
    const capAt = view.z <= 1 ? ""
      : view.tight || !heads.length ? `;bottom:${r3(CAP_LOW * H)}px`
        : `;bottom:${r3(Math.min(CAP_HIGH * H, Math.max(CAP_LOW * H, H - (Math.min(...heads) * view.z + view.ty) + 24)))}px`;
    const caps = makeCaps(sc, t, eid, capAt);
    const stamps = beats.filter((b) => b.fx === "stamp").map((b, i) => `<div id="${eid(`stamp${i + 1}`)}" class="stamp">${esc(b.text)}</div>`);
    html.push([
      `<section id="${sid}" class="clip" data-start="${r3(t.start)}" data-duration="${t.dur}" data-track-index="1">`,
      ...(view.z > 1 ? [`<div class="world" style="transform-origin:0 0;transform:translate(${r3(view.tx)}px,${r3(view.ty)}px) scale(${view.z})">`] : []),
      `<img id="${eid("plate")}" class="plate" src="${esc(assets.plate(sc.place))}" />`,
      ...props.map(propHtml),
      ...cast.filter((c) => !rides(c)).map(actorHtml),
      ...(view.z > 1 ? ["</div>"] : []),
      ...caps.map((c) => c.html),
      ...stamps,
      "</section>",
    ].join("\n    "));

    const cam = CAMERA[sc.camera];
    if (cam) {
      const [from, to] = cam(t.dur, X);
      tw(`#${eid("plate")}`, from, to, T(0));
    }

    const enter = (e, how, at) => {
      if (how === "drop") {
        tw(e.sel, { y: Y(-1700) }, { y: 0, duration: 0.5, ease: "power2.in" }, at);
        if (e.body) tw(`${e.sel}-body`, { scaleY: 0.75, scaleX: 1.2 }, { scaleY: 1, scaleX: 1, duration: 0.45, ease: "elastic.out(1, 0.4)" }, at + 0.5);
      } else if (how === "slide-left") tw(e.sel, { x: X(-900) }, { x: 0, duration: 0.55, ease: "power3.out" }, at);
      else if (how === "slide-right") tw(e.sel, { x: X(900) }, { x: 0, duration: 0.7, ease: "power3.out" }, at);
    };
    for (const c of cast) {
      const e = el[c.who];
      enter(e, c.enter, T(0.05));
      const n = Math.max(0, Math.floor(t.dur / 0.5) - 1);
      tw(`${e.sel}-body`, { scaleY: 1, scaleX: 1 }, { scaleY: 0.97, scaleX: 1.02, duration: 0.5, ease: "sine.inOut", yoyo: true, repeat: n }, T(c.enter === "drop" ? 1 : 0));
    }
    for (const p of props) {
      // ของปูพื้นที่หล่นจากฟ้าดูเป็นแผ่นลอย: คลี่ออกจากซ้ายไปขวาแทน เหมือนปูเสื่อ
      if (flat(p) && p.enter === "drop") {
        tw(el[p.id].sel, { scaleX: 0, transformOrigin: "0% 50%" }, { scaleX: 1, duration: 0.6, ease: "power2.out" }, T(0.05));
      } else enter(el[p.id], p.enter, T(0.05));
    }

    const move = (e, b, at) => {
      const dur = b.dur ?? MOVE_DUR[b.move];
      if (b.move === "hop") tw(e.sel, { y: 0 }, { y: Y(-130), duration: 0.18, ease: "power2.out", yoyo: true, repeat: 1 }, at);
      else if (b.move === "jump") {
        tw(e.sel, { y: 0 }, { y: Y(-420), duration: 0.25, ease: "power2.out" }, at);
        tw(e.sel, { y: Y(-420) }, { y: 0, duration: 0.45, ease: "bounce.out" }, at + 0.25);
      } else if (b.move === "shiver") {
        tw(e.sel, { x: e.cur }, { x: r3(e.cur - X(9)), duration: 0.05, ease: "none", yoyo: true, repeat: Math.round(dur / 0.05) | 1 }, at);
      } else if (b.move === "to" || b.move === "run-to") {
        // ระยะสะสมต่อ element ในฉาก → เดินหลายครั้งต่อกันได้ไม่กระตุกกลับ
        const dx = r3((inFrame(spotX(st, b.to_spot), e.w) - e.x0) * W);
        tw(e.sel, { x: e.cur }, { x: dx, duration: dur, ease: b.move === "run-to" ? "none" : "power1.inOut" }, at);
        e.cur = dx;
        if (b.move === "run-to" && e.body) {
          tw(`${e.sel}-body`, { y: 0 }, { y: Y(-45), duration: 0.13, ease: "sine.inOut", yoyo: true, repeat: Math.round(dur / 0.13) | 1 }, at);
        }
      } else if (b.move === "loop") {
        // วนไปทางฝั่งที่ว่างกว่าของจอ แล้วกลับที่เดิม
        const sign = e.x0 * W + e.cur > W / 2 ? -1 : 1;
        const keyframes = [380, 120, 420, 0].map((v) => ({ x: r3(e.cur + sign * X(v)) }));
        tw(e.sel, { x: e.cur }, { keyframes, duration: dur, ease: "sine.inOut" }, at);
      }
    };
    const poseAt = Object.fromEntries(cast.map((c) => [c.who, [[0, c.pose]]]));
    let stampNo = 0;
    for (const b of beats) {
      const s = beatAt(b, t);
      // ท่าเปลี่ยนที่เฟรมเดียวกับที่ปากเริ่ม (ปัดแบบเดียวกัน)
      if (b.pose && poseAt[b.who]) poseAt[b.who].push([Math.round(s * fps), b.pose]);
      if (b.move && b.who && el[b.who]) move(el[b.who], b, T(s));
      if (b.fx === "shake") tw(`#${sid}`, { x: 0 }, { keyframes: [-26, 22, -14, 8, 0].map((v) => ({ x: X(v) })), duration: 0.4 }, T(s));
      if (b.fx === "stamp") {
        stampNo++;
        tw(`#${eid(`stamp${stampNo}`)}`, { scale: 3, opacity: 0, rotation: -14 }, { scale: 1, opacity: 1, rotation: -5, duration: 0.22, ease: "back.out(3)" }, T(s));
      }
    }

    capTweens(caps, t, T);

    // สลับภาพทีละเฟรม: ท่าจาก beat + ปากจากความดังของบทตัวเอง
    const frames = Math.round(t.dur * fps);
    for (const c of cast) {
      const id = eid(`c-${safe(c.who)}`);
      const open = new Array(frames).fill(false);
      for (const l of t.lines) {
        if (l.who !== c.who) continue;
        const f0 = Math.round(l.start * fps);
        mouthFrames(lines[l.key]?.rms).forEach((o, i) => { if (o && f0 + i < frames) open[f0 + i] = true; });
      }
      const pt = poseAt[c.who].slice().sort((a, b) => a[0] - b[0]);
      let last = null;
      for (let fr = 0; fr < frames; fr++) {
        const pose = pt.filter(([f0]) => f0 <= fr).at(-1)[1];
        const key = `${open[fr] ? "t" : "p"}-${safe(pose)}`;
        if (key === last) continue;
        if (last) set(`#${id}-${last}`, { opacity: 0 }, T(fr / fps));
        set(`#${id}-${key}`, { opacity: 1 }, T(fr / fps));
        last = key;
      }
    }
  });

  const total = r3(times.reduce((s, x) => s + x.dur, 0));
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<script src="vendor/gsap.min.js"></script>
<style>
@font-face { font-family: "${family}"; src: url("fonts/${encodeURIComponent(f.file)}"); font-weight: 700; }
#root { width: ${W}px; height: ${H}px; font-family: "${family}", sans-serif; }
${css}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-fps="${fps}" data-width="${W}" data-height="${H}">
  ${html.join("\n  ")}
</div>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  ${js.join("\n  ")}
  window.__timelines.main = tl;
</script>
</body>
</html>
`;
}
