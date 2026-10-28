import { test } from "node:test";
import assert from "node:assert/strict";
import { narrationTrackArgs, normalizeArgs, ffmpeg } from "../tools/assemble.mjs";
import { mixArgs } from "../tools/audio.mjs";

// apad เปล่า ๆ เติมเงียบไม่รู้จบ: ffmpeg 8 บางครั้งวนค้างตลอดไป → ทุก apad ต้องมี whole_dur
const bareApad = (args) => args.some((a) => /apad(?!=whole_dur=)/.test(a));

test("narrationTrackArgs: เติมเงียบแบบมีขอบเขต และตัดยาวพอดี duration", () => {
  const a = narrationTrackArgs({ items: [{ file: "a.wav", at: 0 }, { file: "b.wav", at: 7.5 }], duration: 20, out: "o.wav" });
  assert.equal(bareApad(a), false);
  const g = a[a.indexOf("-filter_complex") + 1];
  // เงียบยาวพอดี 20 วินาทีเป็นอินพุตสุดท้าย ผสมแบบ longest แล้วตัดที่ 20
  assert.deepEqual(a.slice(4, 10), ["-f", "lavfi", "-t", "20.000", "-i", "anullsrc=r=48000:cl=stereo"]);
  assert.match(g, /\[n0\]\[n1\]\[2:a\]amix=inputs=3:normalize=0:duration=longest,atrim=0:20\.000\[out\]$/);
  assert.doesNotMatch(g, /apad/);
  assert.equal(a[a.indexOf("-t") + 1], "20.000");
  assert.equal(a.at(-1), "o.wav");
});

test("normalizeArgs และ mixArgs: ไม่มี apad ไร้ขอบเขต", () => {
  const n = normalizeArgs({ input: "i.mp4", out: "o.mp4", w: 720, h: 1280, hasAudio: false, seconds: 5 });
  assert.equal(bareApad(n), false);
  assert.ok(n.some((a) => a.includes("apad=whole_dur=5.000")));
  const m = mixArgs({ video: "v.mp4", duration: 5, sceneAudio: true, narration: "n.wav", music: "m.mp3", musicGain: 0.4, out: "o.mp4" });
  assert.equal(bareApad(m), false);
  assert.match(m[m.indexOf("-filter_complex") + 1], /apad=whole_dur=5\.00,asplit=2/);
});

test("ffmpeg ที่ค้างถูก SIGKILL เมื่อหมดเวลา → VfError INTERNAL", async () => {
  const t0 = Date.now();
  await assert.rejects(
    ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000", "-f", "null", "-"], "ทดสอบ", { timeoutMs: 400 }),
    (e) => e.name === "VfError" && e.code === "INTERNAL" && /ค้าง/.test(e.message),
  );
  assert.ok(Date.now() - t0 < 5000);
});
