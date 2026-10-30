import { test } from "node:test";
import assert from "node:assert/strict";
import { poseChecks, poseQuestion, fixMessage, sameLines } from "../tools/motion-check.mjs";
import { poseAt, sceneTimes } from "../tools/hf-compose.mjs";

const plan = () => ({
  scenes: [
    { id: "s01", place: "living", cast: [{ who: "pim", spot: "c", pose: "pushup" }], props: [],
      lines: [{ who: "narrator", text: "พิมวิดพื้นสบาย", en: "Pim does push-ups comfortably" }, { who: "pim", text: "เย่", en: "Yay" }],
      beats: [{ at: "line1-end", who: "pim", pose: "happy" }] },
    { id: "s02", kind: "insert", image: "hero", cast: [], props: [], beats: [], lines: [{ who: "narrator", text: "เสื่อ" }] },
    { id: "s03", place: "living", cast: [{ who: "pim", spot: "a", pose: "idle" }, { who: "bo", spot: "b", pose: "idle" }], props: [], beats: [],
      lines: [{ who: "narrator", text: "สองคน" }] },
  ],
});
const lines = { "1-1": { seconds: 2 }, "1-2": { seconds: 1 }, "2-1": { seconds: 1 }, "3-1": { seconds: 1 } };

test("poseAt: ท่าจาก cast แล้วเปลี่ยนตาม beat เมื่อถึงเวลา", () => {
  const p = plan();
  const t = sceneTimes(p, lines)[0];
  assert.equal(poseAt(p.scenes[0], t, t.lines[0].start + 0.5).pim, "pushup");
  assert.equal(poseAt(p.scenes[0], t, t.lines[1].start + 0.1).pim, "happy");
});

test("poseChecks: กลางบทแต่ละบท ข้าม insert และผู้บรรยายในฉากหลายตัว; ใช้ en", () => {
  const p = plan();
  const times = sceneTimes(p, lines);
  const cs = poseChecks(p, times);
  assert.deepEqual(cs.map((c) => [c.si, c.li, c.who, c.pose]), [[0, 0, "pim", "pushup"], [0, 1, "pim", "happy"]]);
  const l0 = times[0].lines[0];
  assert.ok(Math.abs(cs[0].at - (l0.start + l0.end) / 2) < 0.001);
  assert.match(poseQuestion(cs[0], "Pim"), /Pim does push-ups comfortably/);
});

test("sameLines/fixMessage: แก้ท่าได้ แก้บทไม่ได้; ข้อความระบุฉาก บท ท่า", () => {
  const a = plan();
  const b = plan();
  b.scenes[0].beats = [];
  assert.ok(sameLines(a, b));
  b.scenes[0].lines[0].text = "อื่น";
  assert.ok(!sameLines(a, b));
  const msg = fixMessage(a, [{ si: 0, li: 0, who: "pim", en: "Pim rests", pose: "happy" }], { pim: { happy: "jumping" } });
  assert.match(msg, /scene s01 line 1 \(pim, "Pim rests"\): shown pose "happy" \(jumping\)/);
});
