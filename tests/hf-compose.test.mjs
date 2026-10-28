process.env.VF_NO_DOTENV = "1";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sceneTimes, mouthFrames, composeHtml, audioCues, FONT_FOR, fontFile, captionChunks } from "../tools/hf-compose.mjs";
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
  assert.match(html, /<span>สวัสดี<\/span><span>ครับ<\/span><span>วันนี้<\/span><span>อากาศ<\/span><span>ดีมาก!<\/span>/);
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
