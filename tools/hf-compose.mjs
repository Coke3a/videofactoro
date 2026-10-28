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
const ACTOR_SIZE = 0.42;
const PROP_SIZE = 0.26;
const RIDE_BOTTOM = "30%";
const NARRATOR_COLOR = "#ffffff";
const CAP_COLORS = ["#ffe066", "#ffb36b", "#8fe3ff", "#b6f28b", "#ff9ecb"];
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

// เวลา beat ถูกบีบไว้ในช่วงฉาก → tween และ sfx ไม่ล้นไปฉากถัดไป
const beatAt = (b, t) => Math.min(t.dur, Math.max(0, atSec(b.at, t.lines)));

const byAt = (a, b) => a.at - b.at;

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
export function composeHtml({ plan, times, lines = {}, stage, assets, size = { w: 1080, h: 1920 }, fps = 30, lang = "en", font }) {
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

  plan.scenes.forEach((sc, si) => {
    const t = times[si];
    const sid = `sc${si + 1}`;
    const eid = (k) => `${sid}-${k}`;
    const T = (s) => t.start + s;
    const st = stage?.[sc.place];
    if (!st) throw new VfError("INTERNAL", `ไม่มี stage ของสถานที่ ${sc.place}`);
    const floorPx = (1 - st.floor) * H;
    const cast = sc.cast ?? [];
    const props = sc.props ?? [];
    const beats = sc.beats ?? [];

    // who ใน beat: หาใน cast ก่อน แล้วค่อย props (cast ทับ props)
    const propX = Object.fromEntries(props.map((p) => [p.id, spotX(st, p.spot)]));
    const el = Object.create(null);
    for (const p of props) el[p.id] = { sel: `#${eid(`o-${safe(p.id)}`)}`, x0: propX[p.id], body: false, cur: 0 };
    const rides = (c) => c.ride && Object.hasOwn(propX, c.ride);
    // ตัวที่ขี่ prop อยู่ในกล่องของ prop → ระยะเดินนับจากจุดของ prop
    for (const c of cast) el[c.who] = { sel: `#${eid(`c-${safe(c.who)}`)}`, x0: rides(c) ? propX[c.ride] : spotX(st, c.spot), body: true, cur: 0 };

    const posesOf = (c) => uniq([c.pose, ...beats.filter((b) => b.who === c.who && b.pose).map((b) => b.pose)]);
    const actorHtml = (c) => {
      const aw = (c.size ?? ACTOR_SIZE) * W;
      const ah = aw * SPRITE_RATIO;
      const id = eid(`c-${safe(c.who)}`);
      const imgs = posesOf(c).flatMap((p) => [
        `<img id="${id}-p-${safe(p)}" class="sprite" src="${esc(assets.sprite(c.who, p, false))}" />`,
        `<img id="${id}-t-${safe(p)}" class="sprite" src="${esc(assets.sprite(c.who, p, true))}" />`,
      ]).join("");
      const pos = rides(c)
        // ภาพท่ามีที่ว่างใต้เท้า ~19% → จมลงในยอด prop นิดหน่อยให้ดูนั่งอยู่จริง ไม่ลอย
        ? `left:50%;margin-left:${r3(-aw / 2)}px;bottom:${RIDE_BOTTOM}`
        : `left:${r3(el[c.who].x0 * W - aw / 2)}px;bottom:${r3(floorPx - ah * 0.06)}px`;
      return `<div id="${id}" class="actor" style="${pos};width:${r3(aw)}px;height:${r3(ah)}px"><div id="${id}-body" class="body">${imgs}</div></div>`;
    };
    const propHtml = (p) => {
      const pw = (p.size ?? PROP_SIZE) * W;
      const riders = cast.filter((c) => rides(c) && c.ride === p.id).map(actorHtml).join("");
      return `<div id="${eid(`o-${safe(p.id)}`)}" class="prop" style="left:${r3(propX[p.id] * W - pw / 2)}px;bottom:${r3(floorPx - pw * 0.12)}px;width:${r3(pw)}px;height:${r3(pw)}px">`
        + `<img class="prop-img" src="${esc(assets.prop(p.id))}" />${riders}</div>`;
    };
    const caps = t.lines.map((l, i) => {
      const words = captionChunks(sc.lines[i].text, lang);
      const id = eid(`cap${i + 1}`);
      return { id, words, html: `<div id="${id}" class="cap" style="color:${colors[l.who] ?? NARRATOR_COLOR}">${words.map((w) => `<span>${esc(w)}</span>`).join("")}</div>` };
    });
    const stamps = beats.filter((b) => b.fx === "stamp").map((b, i) => `<div id="${eid(`stamp${i + 1}`)}" class="stamp">${esc(b.text)}</div>`);
    html.push([
      `<section id="${sid}" class="clip" data-start="${r3(t.start)}" data-duration="${t.dur}" data-track-index="1">`,
      `<img id="${eid("plate")}" class="plate" src="${esc(assets.plate(sc.place))}" />`,
      ...props.map(propHtml),
      ...cast.filter((c) => !rides(c)).map(actorHtml),
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
    for (const p of props) enter(el[p.id], p.enter, T(0.05));

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
        const dx = r3((spotX(st, b.to_spot) - e.x0) * W);
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

    t.lines.forEach((l, i) => {
      const c = caps[i];
      tw(`#${c.id} span`, { opacity: 0, y: Y(20) }, { opacity: 1, y: 0, duration: 0.12, stagger: r3((l.end - l.start) / Math.max(1, c.words.length)) }, T(l.start));
      tw(`#${c.id}`, { opacity: 1 }, { opacity: 0, duration: 0.15 }, T(Math.min(t.dur - 0.15, l.end + 0.25)));
    });

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
