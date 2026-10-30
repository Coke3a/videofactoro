process.env.VF_NO_DOTENV = "1";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sceneTimes, mouthFrames, composeHtml, audioCues, FONT_FOR, fontFile, captionChunks, layoutX, ACTOR_SIZE, CROWD_SIZE, SEP, worldZoom, shotView, CLOSE_ZOOM } from "../tools/hf-compose.mjs";
import { DEFAULT_STAGE } from "../tools/stage.mjs";
import { LEAD, GAP, TAIL, SCENE_MIN } from "../tools/motion-plan.mjs";

const r3 = (v) => Math.round(v * 1000) / 1000;
const savedFont = process.env.VF_HF_FONT;
afterEach(() => {
  if (savedFont === undefined) delete process.env.VF_HF_FONT;
  else process.env.VF_HF_FONT = savedFont;
});

const plan = () => ({
  scenes: [
    {
      id: "s01", place: "living", camera: "push",
      cast: [{ who: "biscuit", spot: "left", pose: "idle", size: 0.5, enter: "drop" }],
      props: [{ id: "vacuum", spot: "right", size: 0.3, enter: "slide-right" }],
      lines: [
        { who: "narrator", text: "This is Biscuit." },
        { who: "biscuit", text: "Hello? Are you a <script>alert(1)</script> \"friend\" & 'pal'?" },
      ],
      beats: [
        { at: "line2", who: "biscuit", pose: "curious" },
        { at: "1.6", who: "vacuum", move: "to", to_spot: "center", dur: 1.2 },
        { at: "1.6", fx: "shake" },
        { at: "1.6", fx: "stamp", text: "VRRM<b>!" },
        { at: 1.7, who: "biscuit", move: "jump", sfx: "boing" },
        { at: "line1-end", sfx: "whirr" },
        { at: "2", who: "biscuit", move: "run-to", to_spot: "right", dur: 1 },
      ],
    },
    {
      id: "s02", place: "kitchen", camera: "static",
      cast: [
        { who: "marmalade", spot: "center", pose: "happy", ride: "vacuum" },
        { who: "biscuit", spot: "far-left", pose: "scared", enter: "slide-left" },
      ],
      props: [{ id: "vacuum", spot: "center" }],
      lines: [],
      beats: [{ at: "0", who: "marmalade", move: "hop" }, { at: "0.4", sfx: "pop" }, { at: "0.5", who: "biscuit", move: "shiver", dur: 1 }],
    },
  ],
});

// rms ต่อเฟรม: ดังเป็นช่วง ๆ
const loud = (n) => Array.from({ length: n }, (_, i) => (i % 3 === 2 ? 0.01 : 0.5));
const lines = () => ({ "1-1": { seconds: 1.2, rms: loud(36) }, "1-2": { seconds: 2.5, rms: loud(75) } });
const stage = { living: DEFAULT_STAGE, kitchen: DEFAULT_STAGE };
const assets = {
  plate: (p) => `assets/plate-${p}.jpg`,
  sprite: (who, pose, talk) => `assets/${who}-${pose}${talk ? "-talk" : ""}.png`,
  prop: (id) => `assets/prop-${id}.png`,
};
const compose = (over = {}) => {
  const p = over.plan ?? plan();
  const l = over.lines ?? lines();
  const times = sceneTimes(p, l);
  return composeHtml({ plan: p, times, lines: l, stage, assets, size: { w: 1080, h: 1920 }, fps: 30, lang: "en", ...over, plan: p });
};

test("mouthFrames: เงียบ/ว่าง → ปิดหมด ไม่มี NaN", () => {
  assert.deepEqual(mouthFrames([0, 0, 0]), [false, false, false]);
  assert.deepEqual(mouthFrames([]), []);
  assert.deepEqual(mouthFrames([NaN, 0]), [false, false]);
});

test("mouthFrames: เปิดเมื่อ > 0.3 × max และไม่เปิดติดกันเกิน 4 เฟรม", () => {
  const m = mouthFrames([1, 1, 1, 1, 1, 1]);
  let run = 0, most = 0;
  for (const o of m) { run = o ? run + 1 : 0; most = Math.max(most, run); }
  assert.ok(most <= 4, `เปิดติดกัน ${most}`);
  assert.ok(m.filter(Boolean).length >= 4);
  assert.deepEqual(mouthFrames([0.1, 0.31, 0.29, 1]), [false, true, false, true]);
});

test("sceneTimes: lead + บท + gap + tail ขั้นต่ำ SCENE_MIN และคีย์ 1-based", () => {
  const t = sceneTimes(plan(), lines());
  assert.equal(t.length, 2);
  const d1 = r3(LEAD + 1.2 + GAP + 2.5 + TAIL);
  assert.equal(t[0].id, "s01");
  assert.equal(t[0].start, 0);
  assert.equal(t[0].dur, d1);
  assert.deepEqual(t[0].lines.map((l) => l.key), ["1-1", "1-2"]);
  assert.equal(t[0].lines[0].start, LEAD);
  assert.equal(t[0].lines[1].start, r3(LEAD + 1.2 + GAP));
  assert.equal(t[0].lines[1].end, r3(LEAD + 1.2 + GAP + 2.5));
  assert.equal(t[0].lines[1].who, "biscuit");
  assert.equal(t[1].start, d1);
  assert.equal(t[1].dur, SCENE_MIN);
  assert.throws(() => sceneTimes(plan(), { "1-1": { seconds: 1, rms: [] } }), { name: "VfError", code: "INTERNAL" });
});

test("audioCues: เสียงพากย์ที่ scene start + line start, sfx ตาม beat", () => {
  const p = plan();
  const t = sceneTimes(p, lines());
  const { voices, sfx } = audioCues(p, t);
  assert.deepEqual(voices, [
    { file: "voice-1-1.wav", at: r3(t[0].start + t[0].lines[0].start) },
    { file: "voice-1-2.wav", at: r3(t[0].start + t[0].lines[1].start) },
  ]);
  assert.deepEqual(sfx, [
    { kind: "whirr", at: t[0].lines[0].end },
    { kind: "boing", at: 1.7 },
    { kind: "pop", at: r3(t[1].start + 0.4) },
  ]);
});

test("composeHtml: โครง composition, ระยะรวม, timeline หลัก, ไม่สุ่ม", () => {
  const p = plan();
  const t = sceneTimes(p, lines());
  const html = compose();
  const total = r3(t.reduce((s, x) => s + x.dur, 0));
  assert.match(html, new RegExp(`<div id="root"[^>]*data-composition-id="main"[^>]*data-duration="${total}"`));
  assert.equal(html.match(/<section /g).length, 2);
  assert.match(html, /window\.__timelines\.main = tl;/);
  assert.match(html, /<script src="vendor\/gsap\.min\.js"><\/script>/);
  assert.doesNotMatch(html, /Math\.random|Date\.now/);
  assert.match(html, /src="assets\/plate-living\.jpg"/);
  assert.match(html, /src="assets\/biscuit-curious-talk\.png"/);
  assert.match(html, /src="assets\/prop-vacuum\.png"/);
  assert.equal(compose(), html, "ผลต้องเหมือนเดิมทุกไบต์");
});

test("composeHtml: tween แรกต่อ element render ทันที ตัวถัดไป immediateRender:false", () => {
  const html = compose();
  const seen = new Map();
  const tweens = [...html.matchAll(/tl\.fromTo\(("[^"]+"), (\{.*?\}), (\{.*\}), [\d.]+\);/g)];
  assert.ok(tweens.length > 10);
  for (const [, sel, , to] of tweens) {
    const n = seen.get(sel) ?? 0;
    if (n === 0) assert.doesNotMatch(to, /immediateRender/, `${sel} ตัวแรก`);
    else assert.match(to, /"immediateRender":false/, `${sel} ตัวที่ ${n + 1}`);
    seen.set(sel, n + 1);
  }
  assert.ok([...seen.values()].some((n) => n > 1));
});

test("composeHtml: ตำแหน่งจาก spotX เท้าที่ stage.floor", () => {
  const html = compose();
  const aw = 0.5 * 1080, ah = aw * (1184 / 880);
  const bottom = r3((1 - DEFAULT_STAGE.floor) * 1920 - ah * 0.06);
  assert.match(html, new RegExp(`id="sc1-c-biscuit" class="actor" style="left:${r3(0.25 * 1080 - aw / 2)}px;bottom:${bottom}px;`));
  // vacuum ย้ายจาก right → center = -270px
  assert.match(html, /tl\.fromTo\("#sc1-o-vacuum", \{"x":0\}, \{"x":-270,"duration":1.2,"ease":"power1.inOut","immediateRender":false\}, 1.6\);/);
  // biscuit วิ่งจาก left → right = 540px
  assert.match(html, /tl\.fromTo\("#sc1-c-biscuit", \{"x":0\}, \{"x":540,"duration":1,"ease":"none"/);
  // ตัวที่ขี่อยู่ในกล่องของ prop
  assert.match(html, /id="sc2-o-vacuum"[^>]*>[^]*?id="sc2-c-marmalade" class="actor" style="left:50%;margin-left:-226.8px;bottom:30%;/);
});

test("composeHtml: escape ข้อความจากแผน", () => {
  const html = compose();
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /VRRM<b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;friend&quot;/);
  assert.match(html, /&#39;pal&#39;/);
  assert.match(html, /VRRM&lt;b&gt;!/);
  assert.equal(html.match(/<script/g).length, 2, "มีแค่ gsap กับ timeline");
});

test("composeHtml: คำบรรยายเด้งทีละคำ สีตามผู้พูด ฟอนต์จากตัวเลือก", () => {
  const html = compose({ font: { family: "Noto Sans", file: "NotoSans-Bold.ttf" } });
  assert.match(html, /@font-face \{ font-family: "Noto Sans"; src: url\("fonts\/NotoSans-Bold\.ttf"\)/);
  assert.match(html, /id="sc1-cap1" class="cap" style="color:#ffffff"><span>This<\/span><span>is<\/span><span>Biscuit.<\/span>/);
  assert.match(html, /id="sc1-cap2" class="cap" style="color:#ffd60a">/);
  assert.match(html, /tl\.fromTo\("#sc1-cap1 span", \{"opacity":0,"y":20\}, \{"opacity":1,"y":0,"duration":0.12,"stagger":0.4\}, 0.45\);/);
});

test("composeHtml: ปากขยับเป็น tl.set สลับ pose กับ -talk", () => {
  const html = compose();
  // biscuit พูดบทที่ 2 ซึ่งเปลี่ยนเป็น curious พอดี → ปากขยับบน curious
  assert.match(html, /tl\.set\("#sc1-c-biscuit-p-idle", \{"opacity":1\}, 0\);/);
  assert.match(html, /tl\.set\("#sc1-c-biscuit-p-idle", \{"opacity":0\}, [\d.]+\);/);
  assert.match(html, /tl\.set\("#sc1-c-biscuit-t-curious", \{"opacity":1\}, [\d.]+\);/);
  assert.match(html, /tl\.set\("#sc1-c-biscuit-t-curious", \{"opacity":0\}, [\d.]+\);/);
  assert.doesNotMatch(html, /sc1-c-biscuit-t-idle", \{"opacity":1/);
  // marmalade ไม่พูด → ตั้งครั้งเดียว
  assert.equal(html.match(/tl\.set\("#sc2-c-marmalade-/g).length, 1);
});

test("composeHtml ภาษาไทย: ใช้ฟอนต์ไทยและแบ่งคำบรรยายเป็นช่วงสั้น", () => {
  const p = plan();
  p.scenes[0].lines[1].text = "สวัสดีครับ วันนี้อากาศดีมาก!";
  const html = compose({ plan: p, lang: "th" });
  assert.match(html, /src: url\("fonts\/Loma-Bold\.otf"\)/);
  // ช่วงที่ตัดเองติดกัน (class tight ไม่มี margin) · ช่วงที่ต้นฉบับเว้นวรรคไว้ได้ class g
  assert.match(html, /class="cap tight"[^>]*><span>สวัสดี<\/span><span>ครับ<\/span><span class="g">วันนี้<\/span><span>อากาศ<\/span><span>ดีมาก!<\/span>/);
  assert.deepEqual(captionChunks("Hi  there you", "en"), ["Hi", "there", "you"]);
});

test("FONT_FOR และ fontFile", () => {
  assert.equal(FONT_FOR("en").family, "Noto Sans");
  assert.ok(FONT_FOR("en").candidates.includes("/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"));
  const th = FONT_FOR("th");
  // Loma (fonts-thai-tlwg) มีตัวละตินด้วย → คำ stamp ภาษาอังกฤษในคลิปไทยไม่ตกไปใช้ฟอนต์อื่น
  assert.equal(th.family, "Loma");
  assert.match(th.candidates[0], /tlwg\/Loma-Bold\./);
  assert.ok(th.candidates.includes("/usr/share/fonts/truetype/noto/NotoSansThai-Bold.ttf"));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vf-font-")), "fixture.ttf");
  fs.writeFileSync(f, "font");
  process.env.VF_HF_FONT = f;
  assert.equal(fontFile("th"), f);
  process.env.VF_HF_FONT = path.join(path.dirname(f), "missing.ttf");
  assert.throws(() => fontFile("th"), { name: "VfError", code: "CONFIG" });
  delete process.env.VF_HF_FONT;
  const have = th.candidates.find((c) => fs.existsSync(c));
  if (have) assert.equal(fontFile("th"), have);
  else assert.throws(() => fontFile("th"), (e) => e.code === "CONFIG" && /fonts-noto-core/.test(e.message));
});

test("ท่าเปลี่ยนตรงเฟรมเดียวกับปาก: ไม่โชว์ -talk ของท่าเก่าแม้เฟรมเดียว", () => {
  // บทที่ 2 เริ่ม 1.94 s = เฟรม 58.2 → ปากเริ่มเฟรม 58; ท่า curious ต้องเริ่มเฟรม 58 ด้วย
  const l = { "1-1": { seconds: 1.19, rms: loud(36) }, "1-2": { seconds: 2.5, rms: loud(75) } };
  const html = compose({ lines: l });
  assert.doesNotMatch(html, /sc1-c-biscuit-t-idle", \{"opacity":1/);
  assert.match(html, /tl\.set\("#sc1-c-biscuit-t-curious", \{"opacity":1\}, 1\.933\);/);
});

test("beat ที่เลยท้ายฉากถูกตัดไว้ที่ท้ายฉาก ทั้ง tween และ sfx", () => {
  const p = plan();
  p.scenes[0].beats.push({ at: "99", who: "biscuit", move: "hop", sfx: "bang" }, { at: "50", fx: "shake" });
  const l = lines();
  const t = sceneTimes(p, l);
  const end = r3(t[0].start + t[0].dur);
  const html = compose({ plan: p });
  assert.match(html, new RegExp(`tl\\.fromTo\\("#sc1-c-biscuit", \\{"y":0\\}, \\{"y":-130,[^}]*\\}, ${end}\\);`));
  assert.match(html, new RegExp(`tl\\.fromTo\\("#sc1", \\{"x":0\\}, .*, ${end}\\);`));
  for (const m of html.matchAll(/tl\.fromTo\("#sc1[^"]*", .*, ([\d.]+)\);/g)) assert.ok(Number(m[1]) <= end, m[0]);
  const bang = audioCues(p, t).sfx.find((c) => c.kind === "bang");
  assert.equal(bang.at, end);
});

test("ชื่อผู้พูดแปลก ๆ อย่าง __proto__ ไม่ทำสีพัง", () => {
  const p = plan();
  p.scenes[0].lines[0].who = "__proto__";
  const html = compose({ plan: p });
  assert.match(html, /id="sc1-cap1" class="cap" style="color:#ffd60a">/);
  assert.doesNotMatch(html, /object Object/);
});

const fits = (pos, items) => {
  const xs = items.map((it) => ({ ...it, x: pos[it.key] })).sort((a, b) => a.x - b.x);
  for (const it of xs) {
    assert.ok(it.x - it.w / 2 >= -1e-9 && it.x + it.w / 2 <= 1 + 1e-9, `${it.key} หลุดขอบ x=${it.x}`);
  }
  for (let k = 1; k < xs.length; k++) {
    const need = (SEP * (xs[k - 1].w + xs[k].w)) / 2;
    assert.ok(xs[k].x - xs[k - 1].x >= need - 1e-3, `${xs[k - 1].key}–${xs[k].key} ชิดเกิน`);
  }
};

test("layoutX: ทุกตัวอยู่ในเฟรมเต็มตัวและห่างกันอย่างน้อย SEP", () => {
  // ตัวเดียวที่ far-right: ดันเข้าจนขอบขวาพอดีเฟรม
  assert.deepEqual(layoutX([{ key: "pip", x: 0.86, w: 0.42 }]), { pip: 0.79 });
  // ฉาก 8 ของคลิปสอง: left / center / far-right
  const three = [{ key: "a", x: 0.25, w: CROWD_SIZE }, { key: "b", x: 0.5, w: CROWD_SIZE }, { key: "c", x: 0.86, w: CROWD_SIZE }];
  const pos = layoutX(three);
  fits(pos, three);
  assert.ok(pos.a < pos.b && pos.b < pos.c);
  assert.equal(pos.a, 0.25, "ตัวที่ไม่ชนไม่ต้องขยับ");
  // ยืนจุดเดียวกัน: แยกตามลำดับใน cast ผลเหมือนเดิมทุกครั้ง
  const same = [{ key: "x", x: 0.5, w: ACTOR_SIZE }, { key: "y", x: 0.5, w: ACTOR_SIZE }];
  const p2 = layoutX(same);
  fits(p2, same);
  assert.ok(p2.x < p2.y);
  assert.deepEqual(layoutX(same), p2);
  // ชนขอบขวาหลายตัว: ดันกลับมาทางซ้าย
  const right = [{ key: "a", x: 0.86, w: CROWD_SIZE }, { key: "b", x: 0.86, w: CROWD_SIZE }, { key: "c", x: 0.75, w: CROWD_SIZE }];
  fits(layoutX(right), right);
  // ใหญ่เกินจนวางห่างไม่ได้: กระจายเท่า ๆ กันแต่ยังอยู่ในเฟรม
  const big = [{ key: "a", x: 0.5, w: 0.6 }, { key: "b", x: 0.5, w: 0.6 }, { key: "c", x: 0.5, w: 0.6 }];
  const pb = layoutX(big);
  assert.deepEqual(Object.values(pb), [0.3, 0.5, 0.7]);
});

test("composeHtml: ฉาก 3 ตัวย่อลงเป็น CROWD_SIZE ไม่หลุดขอบ ไม่ทับกัน รวมตัวที่ขี่ prop", () => {
  const p = plan();
  p.scenes[1].cast = [
    { who: "marmalade", spot: "left", pose: "idle" },
    { who: "biscuit", spot: "far-left", pose: "sad" },
    { who: "pip", spot: "center", pose: "happy", ride: "vacuum" },
  ];
  p.scenes[1].beats = [{ at: "0.5", who: "marmalade", move: "to", to_spot: "far-right" }];
  const html = compose({ plan: p });
  const W = 1080;
  const aw = CROWD_SIZE * W;
  const left = (id) => Number(new RegExp(`id="sc2-${id}" class="(?:actor|prop)" style="left:([-\\d.]+)px;`).exec(html)[1]);
  const width = (id) => Number(new RegExp(`id="sc2-${id}" class="(?:actor|prop)" style="[^"]*width:([\\d.]+)px`).exec(html)[1]);
  assert.equal(width("c-marmalade"), r3(aw));
  const pw = width("o-vacuum");
  const items = [
    { key: "marmalade", x: (left("c-marmalade") + aw / 2) / W, w: CROWD_SIZE },
    { key: "biscuit", x: (left("c-biscuit") + aw / 2) / W, w: CROWD_SIZE },
    // ตัวที่ขี่อยู่กลางกล่อง prop → นับเป็นตัวเดียวกว้างเท่าตัวละคร
    { key: "vacuum", x: (left("o-vacuum") + pw / 2) / W, w: CROWD_SIZE },
  ];
  fits(Object.fromEntries(items.map((it) => [it.key, it.x])), items);
  assert.match(html, new RegExp(`id="sc2-c-pip" class="actor" style="left:50%;margin-left:${r3(-aw / 2)}px;`));
  // เดินไป far-right ก็หยุดก่อนหลุดขอบ
  const dx = Number(/tl\.fromTo\("#sc2-c-marmalade", \{"x":0\}, \{"x":([-\d.]+),/.exec(html)[1]);
  assert.ok(left("c-marmalade") + dx + aw <= W + 1e-6, String(dx));
  assert.ok(ACTOR_SIZE > CROWD_SIZE);
});

// prop จากรูปจริง: ข้อมูลมาจาก assets.propInfo (listProps)
const matPlan = () => ({
  scenes: [{
    id: "s01", place: "living", camera: "static",
    cast: [{ who: "pim", spot: "center", pose: "pushup", ride: "mat" }],
    props: [{ id: "mat", spot: "center", size: 0.2 }],
    lines: [], beats: [],
  }],
});
const withInfo = (info) => ({ ...assets, propInfo: (id) => info[id] });
const styleOf = (html, id) => new RegExp(`id="${id}" class="(?:actor|prop)" style="([^"]*)"`).exec(html)[1];
const num = (style, k) => Number(new RegExp(`${k}:([-\\d.]+)px`).exec(style)[1]);

test("composeHtml: prop ที่ไม่มี propInfo = กล่องจัตุรัสแบบเดิม", () => {
  const html = compose({ plan: matPlan() });
  const st = styleOf(html, "sc1-o-mat");
  assert.equal(num(st, "width"), num(st, "height"));
  // ไม่มี propInfo → ขี่อยู่ในกล่องของ prop เหมือนเดิม
  assert.match(html, /id="sc1-o-mat" class="prop"[^>]*><img class="prop-img"[^>]*\/><div id="sc1-c-pim"/);
});

test("composeHtml: floor prop เอียงลงนอน, size_cm ชนะ size, ตัวละครยืนบนพื้นตรงจุดของ prop ไม่อยู่ในกล่อง", () => {
  const html = compose({ plan: matPlan(), assets: withInfo({ mat: { placement: "floor", size_cm: 185, aspect: 2.5, trimmed: true } }) });
  const st = styleOf(html, "sc1-o-mat");
  const w = num(st, "width");
  // 185 ซม. เทียบตัวละคร 160 ซม. → กว้างกว่า size 0.2 ของ LLM และสูง = กว้าง / aspect
  assert.ok(w > 0.2 * 1080 * 1.5, String(w));
  assert.ok(Math.abs(num(st, "height") - w / 2.5) < 0.01);
  assert.match(html, /class="prop-flat" style="transform:perspective\(\d+px\) rotateX\(\d+deg\)"/);
  // ตัวละครไม่ได้อยู่ในกล่อง prop และกึ่งกลางตรงกับ prop
  assert.doesNotMatch(html, /id="sc1-o-mat"[^]*?<div id="sc1-c-pim"[^]*?<\/div><\/div><\/div>\s*<\/section>/);
  const a = styleOf(html, "sc1-c-pim");
  const centre = (s) => num(s, "left") + num(s, "width") / 2;
  assert.ok(Math.abs(centre(a) - centre(st)) < 0.5, `${centre(a)} vs ${centre(st)}`);
});

test("composeHtml: upright รูปจริงคงสัดส่วน (สูง = กว้าง / aspect) และขนาดตาม size_cm", () => {
  const p = matPlan();
  p.scenes[0].cast[0].ride = undefined;
  const small = compose({ plan: p, assets: withInfo({ mat: { placement: "upright", size_cm: 30, aspect: 0.5, trimmed: true } }) });
  const big = compose({ plan: p, assets: withInfo({ mat: { placement: "upright", size_cm: 120, aspect: 0.5, trimmed: true } }) });
  const s1 = styleOf(small, "sc1-o-mat"), s2 = styleOf(big, "sc1-o-mat");
  assert.ok(Math.abs(num(s1, "height") - num(s1, "width") / 0.5) < 0.01);
  assert.ok(Math.abs(num(s2, "width") / num(s1, "width") - 4) < 0.01);
});

test("composeHtml: floor prop ที่ enter drop คลี่ออกตามแนวนอน ไม่หล่นจากฟ้า; upright ยังหล่นแบบเดิม", () => {
  const p = matPlan();
  p.scenes[0].props[0].enter = "drop";
  const floor = compose({ plan: p, assets: withInfo({ mat: { placement: "floor", size_cm: 185, aspect: 2.5, trimmed: true } }) });
  assert.match(floor, /tl\.fromTo\("#sc1-o-mat", \{"scaleX":0,"transformOrigin":"0% 50%"\}/);
  assert.doesNotMatch(floor, /tl\.fromTo\("#sc1-o-mat", \{"y":/);
  p.scenes[0].cast[0].ride = undefined;
  const up = compose({ plan: p, assets: withInfo({ mat: { placement: "upright", size_cm: 50, aspect: 1, trimmed: true } }) });
  assert.match(up, /tl\.fromTo\("#sc1-o-mat", \{"y":/);
});

test("worldZoom: ไม่ซูม = 1; ซูมแล้วทุกชิ้นยังอยู่ในเฟรม; ชิ้นกระจายกว้างจนซูมไม่ได้ = 1", () => {
  assert.deepEqual(worldZoom({ zoom: 1, W: 1080, extents: [[300, 700]] }), { z: 1, ox: 540 });
  const fit = (v, ex) => ex.every(([l, r]) => v.ox + (l - v.ox) * v.z >= 0 && v.ox + (r - v.ox) * v.z <= 1080);
  const one = [[340, 740]];
  const v1 = worldZoom({ zoom: 1.5, W: 1080, extents: one });
  assert.equal(v1.z, 1.5);
  assert.ok(fit(v1, one));
  const two = [[60, 500], [600, 1000]];
  const v2 = worldZoom({ zoom: 1.6, W: 1080, extents: two });
  assert.ok(v2.z > 1 && v2.z < 1.6 && fit(v2, two), JSON.stringify(v2));
  assert.equal(worldZoom({ zoom: 1.5, W: 1080, extents: [[0, 1080]] }).z, 1);
});

test("composeHtml zoom: ห่อฉากหลัง/ตัวละคร/prop ใน .world ยึดระดับเท้า คำบรรยายอยู่นอกและยกสูงขึ้น", () => {
  const plain = compose({ plan: matPlan() });
  assert.doesNotMatch(plain, /class="world"/);
  const p = matPlan();
  p.scenes[0].lines = [{ who: "pim", text: "hello there friend" }];
  const html = compose({ plan: p, lines: { "1-1": { seconds: 1, rms: loud(30) } }, zoom: 1.4 });
  assert.match(html, /<div class="world" style="transform-origin:0 0;transform:translate\(-?[\d.]+px,-?[\d.]+px\) scale\(1\.4\)">\s*<img id="sc1-plate"/);
  assert.match(html, /<\/div>\s*<\/div>\s*<div id="sc1-cap1" class="cap" style="color:[^;"]+;bottom:[\d.]+px"/);
});

test("shotView: close เล็งหน้าไปที่ 36% จากบน, low เล็งเท้า 66%, world คลุมเฟรมเสมอ; ไม่มี focus = wide", () => {
  const base = { W: 1080, H: 1920, feetPx: 200, extents: [[400, 700]], focus: { x: 540, face: 900, feet: 1700, head: 800 } };
  const c = shotView({ ...base, shot: "close" });
  assert.equal(c.z, CLOSE_ZOOM);
  assert.ok(Math.abs(900 * c.z + c.ty - 0.36 * 1920) < 0.01 && c.tight);
  const l = shotView({ ...base, shot: "low" });
  // เท้าใกล้ขอบล่าง: เลื่อนได้ไม่เกินขอบ world → ty ถูกบีบที่ H(1−z)
  assert.equal(l.ty, 1920 * (1 - CLOSE_ZOOM));
  const edge = shotView({ ...base, shot: "close", focus: { ...base.focus, x: 30 } });
  assert.equal(edge.tx, 0);
  assert.deepEqual(shotView({ ...base, shot: "close", focus: undefined }), { z: 1, tx: 0, ty: 0, tight: false });
  const m = shotView({ ...base, shot: "medium" });
  assert.ok(m.z > 1 && !m.tight);
});

const cardAssets = {
  ...assets,
  product: { name: "Mat", price_text: "฿108", cta: "Buy", images: [{ id: "hero", role: "hero" }, { id: "d1", role: "detail" }] },
  productImage: (id) => ({ hero: { src: "assets/product-hero.png", w: 276, h: 712, cutout: true }, d1: { src: "assets/product-d1.jpg", w: 600, h: 600, cutout: false } })[id],
};
const cardPlan = () => ({
  scenes: [
    { id: "s01", kind: "insert", image: "hero", chip: "Yoga <mat>", place: "living", camera: "static", cast: [], props: [], beats: [], lines: [{ who: "narrator", text: "meet it" }] },
    { id: "s02", kind: "insert", image: "d1", place: "living", camera: "static", cast: [], props: [], beats: [], lines: [] },
    { id: "s03", kind: "endcard", place: "living", camera: "static", cast: [], props: [], beats: [], lines: [] },
  ],
});

test("composeHtml insert/endcard: รูปจริงทั้งรูปตามสัดส่วน ไม่ใช้ plate, ป้าย escape, ฉากปิดมีชื่อ ราคา ชวนซื้อ", () => {
  const html = compose({ plan: cardPlan(), assets: cardAssets, lines: { "1-1": { seconds: 1, rms: loud(30) } } });
  assert.doesNotMatch(html, /class="plate"/);
  const hero = /id="sc1-photo" class="card-photo cutout" style="left:[\d.]+px;top:[\d.]+px;width:([\d.]+)px;height:([\d.]+)px"/.exec(html);
  assert.ok(hero, "hero photo");
  assert.ok(Math.abs(Number(hero[1]) / Number(hero[2]) - 276 / 712) < 0.001);
  assert.match(html, /class="card-photo framed"[^>]*><img id="sc2-photo-img" src="assets\/product-d1\.jpg"/);
  assert.match(html, /class="chip"[^>]*>Yoga &lt;mat&gt;<\/div>/);
  assert.match(html, /tl\.fromTo\("#sc1-photo-img", \{"scale":1\}, \{"scale":1\.07/);
  assert.match(html, /class="end-name"[^>]*>Mat<\/div>/);
  assert.doesNotMatch(html, /class="end-price"/, "ราคาปิดเป็นค่าเริ่มต้น");
  assert.match(html, /class="end-cta"[^>]*><span>Buy<\/span>/);
  assert.doesNotMatch(html, /"yoyo"/, "ป้ายไม่เต้น");
  assert.match(html, /id="sc1-cap1" class="cap"[^>]*bottom:192px/);
  const priced = compose({ plan: cardPlan(), assets: { ...cardAssets, product: { ...cardAssets.product, show_price: true } }, lines: { "1-1": { seconds: 1, rms: loud(30) } } });
  assert.match(priced, /class="end-price"[^>]*>฿108<\/div>/);
});

test("composeHtml spriteFoot: ที่ว่างใต้เท้าจริงยกหรือลดกล่องตัวละคร; ไม่ส่ง = ค่าเดิม", () => {
  const bottomOf = (html) => num(styleOf(html, "sc1-c-pim"), "bottom");
  const p = matPlan();
  p.scenes[0].cast[0].ride = undefined;
  p.scenes[0].props = [];
  const def = bottomOf(compose({ plan: p }));
  const same = bottomOf(compose({ plan: p, assets: { ...assets, spriteFoot: () => 0.19 } }));
  const low = bottomOf(compose({ plan: p, assets: { ...assets, spriteFoot: () => 0.03 } }));
  assert.ok(Math.abs(def - same) < 0.01);
  assert.ok(low > def);
});

test("composeHtml hook: ป้ายบนฉากแรกเท่านั้น escape แล้ว, ไม่มี hook = ไม่มีป้าย", () => {
  const p = cardPlan();
  p.hook = "Mat <test>?";
  const html = compose({ plan: p, assets: cardAssets, lines: { "1-1": { seconds: 1, rms: loud(30) } } });
  assert.match(html, /<section id="sc1"[\s\S]*id="sc1-hook" class="hook"[^>]*>Mat &lt;test&gt;\?<\/div>[\s\S]*<\/section>\s*<section id="sc2"/);
  assert.equal((html.match(/class="hook"/g) ?? []).length, 1);
  assert.doesNotMatch(compose({ plan: cardPlan(), assets: cardAssets, lines: { "1-1": { seconds: 1, rms: loud(30) } } }), /class="hook"/);
});

test("composeHtml close/low: ตัวที่ focus ยืนริมห้องถูกเลื่อนมากลางจอ ไม่หลุดขอบ", () => {
  const screenX = (shot) => {
    const p = matPlan();
    p.scenes[0].cast = [{ who: "pim", spot: "far-left", pose: "idle" }];
    p.scenes[0].props = [];
    Object.assign(p.scenes[0], { shot, focus: "pim" });
    const html = compose({ plan: p });
    const s = styleOf(html, "sc1-c-pim");
    const m = /class="world" style="transform-origin:0 0;transform:translate\(([-\d.]+)px,[-\d.]+px\) scale\(([\d.]+)\)"/.exec(html);
    const [tx, z] = m ? [Number(m[1]), Number(m[2])] : [0, 1];
    return ((num(s, "left") + num(s, "width") / 2) * z + tx) / 1080;
  };
  for (const shot of ["close", "low"]) assert.ok(Math.abs(screenX(shot) - 0.5) < 0.05, `${shot}: ${screenX(shot)}`);
  // wide ไม่เลื่อน: ยังอยู่ริมซ้าย
  assert.ok(screenX("wide") < 0.3);
});
