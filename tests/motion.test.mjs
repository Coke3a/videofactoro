process.env.VF_NO_DOTENV = "1";
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as cf from "../tools/cf.mjs";
import { MODELS } from "../tools/models.mjs";
import { main as create } from "../tools/project-create.mjs";
import { main as motion } from "../tools/motion.mjs";
import { setRunner } from "../tools/hf.mjs";
import { validateScenePlan, validateStory } from "../tools/motion-plan.mjs";
import { SFX_KINDS } from "../tools/fx.mjs";
import { goodBible } from "./fixtures/bible.mjs";
import { bodyOf } from "./fixtures/body.mjs";
import { TINY, STORY, SCENES, STORY_MARK, SCENES_MARK, STAGING_KEY, prepareMotionProject, stubRunner } from "./fixtures/motion.mjs";

const B64 = fs.readFileSync(TINY).toString("base64");
const ENV = { CLOUDFLARE_AI_ACCOUNT_ID: "acc1", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456" };
const ENV_KEYS = [...Object.keys(ENV), "VF_PROJECTS", "VF_HF_FONT"];

let WAV, MP3, FONT, root, dir, saved, calls, origWrite, staging, story, storyQueue, scenes;
const reply = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });
const posts = (model) => calls.filter((c) => c.body?.model === model);
const clefs = () => calls.filter((c) => c.url.includes("clef-omni"));
const paid = () => calls.filter((c) => c.method === "POST");
const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", f], { encoding: "utf8" }));
const ARGS = ["demo", "--prompt", "cat and dog chase a ball", "--duration", "20", "--foreground"];

before(() => {
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "vf-motionfix-"));
  // TTS ปลอม: เงียบ 0.3 วินาที + เสียง 1 วินาที + เงียบ 0.3 วินาที → ตัดเงียบแล้วเหลือราว 1 วินาที
  WAV = path.join(fx, "n.wav");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono:d=0.3", "-f", "lavfi", "-i", "sine=frequency=220:duration=1:sample_rate=24000",
    "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono:d=0.3", "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]", "-map", "[a]", "-ac", "1", WAV]);
  MP3 = path.join(fx, "m.mp3");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=30", "-ac", "1", "-b:a", "32k", MP3]);
  FONT = path.join(fx, "Test-Bold.ttf");
  fs.writeFileSync(FONT, "not really a font");
});

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vf-motion-"));
  Object.assign(process.env, ENV, { VF_PROJECTS: root, VF_HF_FONT: FONT });
  cf.setSleep(async () => {});
  staging = 0.1;
  story = STORY();
  storyQueue = [];
  scenes = SCENES();
  calls = [];
  cf.setFetch(async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://cdn.example/m")) return new Response(fs.readFileSync(MP3));
    const body = bodyOf(url, init);
    calls.push({ url: u, method: init.method ?? "GET", body });
    if (u.includes("clef-omni")) {
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { noul: k === STAGING_KEY ? staging : /text/.test(k) || k === "has_people_or_animals" ? 0 : 0.9 }]));
      return reply({ answers, usage: { prompt_tokens: 1500 } });
    }
    if (body?.model === MODELS.image || body?.model === MODELS.imageFast) return reply({ image: B64 });
    if (body?.model === MODELS.music) return reply({ state: "Completed", result: { audio: "https://cdn.example/m.mp3" } });
    if (body?.model === MODELS.tts) return reply({ audio: "data:audio/wav;base64," + fs.readFileSync(WAV).toString("base64") });
    if (body?.model === MODELS.llm[0]) {
      const sys = body.input.systemInstruction.parts[0].text;
      const data = sys.includes("story bible") ? goodBible() : sys.includes(STORY_MARK) ? (storyQueue.shift() ?? story) : sys.includes(SCENES_MARK) ? scenes : null;
      if (!data) throw new Error("unexpected llm call");
      return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 300 } });
    }
    throw new Error("unexpected fetch " + u + " " + JSON.stringify(body).slice(0, 200));
  });
  origWrite = process.stderr.write;
  process.stderr.write = () => true;
  await create(["--prompt", "แมวกับหมาในครัว", "--name", "demo", "--foreground"]);
  dir = path.join(root, "demo");
  prepareMotionProject(dir);
  calls.length = 0;
});

afterEach(() => {
  setRunner(null);
  process.stderr.write = origWrite;
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  cf.setFetch((...a) => globalThis.fetch(...a));
  fs.rmSync(root, { recursive: true, force: true });
});

const ASSETS = { poses: { cat: ["idle", "happy"], dog: ["idle", "happy"] }, places: { kitchen: ["left", "center", "right", "far-left", "far-right"] }, props: ["ball"], sfx: SFX_KINDS };

test("fixture: story และ scenes ผ่าน validator (narrator true, en, 20 วินาที)", () => {
  assert.deepEqual(validateStory(STORY()), []);
  assert.deepEqual(validateScenePlan(SCENES(), ASSETS, { total: 20, lang: "en", narrator: true }), []);
});

test("motion: story → props → stage → scenes → tts → compose → lint → check → render → เสียง → renders/<id>.mp4", async () => {
  const runner = stubRunner();
  setRunner(runner);
  const r = await motion([...ARGS, "--no-reuse"]);
  const m = r.motion;
  assert.match(m.id, /^ball-panic-[0-9a-f]{4}$/);
  assert.equal(m.file, path.join(dir, "renders", `${m.id}.mp4`));
  assert.ok(fs.existsSync(m.file));
  assert.equal(m.dir, path.join(dir, "motions", m.id));
  for (const f of ["index.html", "plan.json", "video.mp4", "vendor/gsap.min.js", "fonts/Test-Bold.ttf", "voice-1-1.wav", "voice-4-2.wav",
    "assets/plate-kitchen.jpg", "assets/cat-idle.png", "assets/cat-happy-talk.png", "assets/prop-ball.png"]) {
    assert.ok(fs.existsSync(path.join(m.dir, f)), f);
  }
  assert.ok(fs.existsSync(path.join(dir, "props", "ball", "prop.png")), "prop ใหม่ถูกสร้างก่อนวางแผนฉาก");
  const html = fs.readFileSync(path.join(m.dir, "index.html"), "utf8");
  assert.match(html, /src="assets\/plate-kitchen\.jpg"/);
  assert.match(html, /font-family: "Noto Sans"/);
  // 4 ฉาก × (0.45 + 1 + 0.3 + 1 + 0.7) วินาที
  const want = Number(/id="root"[^>]*data-duration="([\d.]+)"/.exec(html)[1]);
  assert.ok(Math.abs(want - 4 * 3.45) < 0.2, `data-duration ${want}`);
  assert.ok(Math.abs(m.seconds - want) < 0.05);
  const out = probe(m.file);
  assert.deepEqual(out.streams.map((s) => s.codec_type).sort(), ["audio", "video"]);
  assert.ok(Math.abs(Number(out.format.duration) - want) < 0.3, `ยาว ${out.format.duration} vs ${want}`);
  assert.equal(m.scenes, 4);
  assert.equal(m.narration, true);
  assert.equal(m.music, true);
  assert.equal(m.sfx, true);
  assert.equal(m.music_track.reused, false);
  assert.match(m.warnings.join("\n"), /no-reuse/);
  assert.match(m.warnings.join("\n"), /overlapping_gsap_tweens/);
  assert.doesNotMatch(m.warnings.join("\n"), /ฉาก \d+:.*ยืน/);
  // จ่ายตามที่วางแผน: LLM 2, TTS ทุกบท, prop 1 ภาพ, ไม่มีวิดีโอ
  assert.equal(posts(MODELS.llm[0]).length, 2);
  assert.equal(posts(MODELS.tts).length, 8);
  assert.equal(posts(MODELS.imageFast).length, 1);
  assert.equal(posts(MODELS.video).length, 0);
  const narrator = posts(MODELS.tts).filter((c) => c.body.input.voice === "Kore");
  assert.equal(narrator.length, 4, "ผู้บรรยายใช้ narrator_voice");
  assert.equal(posts(MODELS.tts).filter((c) => c.body.input.voice === "Charon").length, 4, "หมาใช้ tts_voice ของตัวเอง");
  // check: snapshot กลางฉากละครั้ง แล้วถาม clef ทีละฉาก
  const snap = runner.seen.find((a) => a[0] === "snapshot");
  assert.equal(snap[snap.indexOf("--at") + 1].split(",").length, 4);
  assert.equal(clefs().filter((c) => c.body.questions[STAGING_KEY]).length, 4);
  assert.equal(clefs().find((c) => c.body.questions[STAGING_KEY]).body.questions[STAGING_KEY].instructions,
    "Is any character standing on furniture, cut off by the frame edge, or floating in the air?");
  const plan = JSON.parse(fs.readFileSync(path.join(m.dir, "plan.json"), "utf8"));
  assert.equal(plan.scenes.length, 4);
  assert.ok(fs.readFileSync(path.join(dir, "EPISODES.md"), "utf8").includes("| motion | Ball Panic |"));
  assert.ok(r.cost.usd > 0);
  await assert.rejects(motion(ARGS), (e) => e.code === "USAGE" && /เสร็จแล้ว/.test(e.message));
});

test("motion: ตัวละครที่ยังไม่มีท่า → USAGE บอกคำสั่ง ไม่เรียก API เลย", async () => {
  setRunner(stubRunner());
  fs.rmSync(path.join(dir, "characters", "dog", "poses"), { recursive: true });
  await assert.rejects(motion(ARGS), (e) => e.code === "USAGE" && e.message.includes("ยังไม่มีท่าของตัวละคร") && e.message.includes("vf character poses demo dog"));
  await assert.rejects(motion([...ARGS.slice(0, -1)]), (e) => e.code === "USAGE", "background ก็ต้องปฏิเสธก่อนเริ่ม job");
  assert.equal(calls.length, 0);
});

test("motion: lint มี error → INTERNAL พร้อมข้อความ lint ไม่ render", async () => {
  const runner = stubRunner({ lint: "✖ missing_timeline: no timeline\n◇  2 error(s), 0 warning(s)" });
  setRunner(runner);
  await assert.rejects(motion(ARGS), (e) => e.code === "INTERNAL" && /missing_timeline/.test(e.message + JSON.stringify(e.details ?? {})));
  assert.equal(runner.seen.filter((a) => a[0] === "render").length, 0);
});

test("motion: render พังแล้วรันซ้ำ → ไม่เรียก LLM/TTS/clef ใหม่; คำเตือน check ยังอยู่", async () => {
  staging = 0.8;
  let fail = true;
  setRunner(stubRunner({ renderFail: () => fail }));
  await assert.rejects(motion(ARGS), (e) => e.code === "INTERNAL");
  const before = { llm: posts(MODELS.llm[0]).length, tts: posts(MODELS.tts).length, clef: clefs().length, img: posts(MODELS.imageFast).length };
  assert.equal(before.tts, 8);
  fail = false;
  const r = await motion(ARGS);
  assert.ok(fs.existsSync(r.motion.file));
  assert.equal(posts(MODELS.llm[0]).length, before.llm, "ไม่เรียก LLM ซ้ำ");
  assert.equal(posts(MODELS.tts).length, before.tts, "ไม่เรียก TTS ซ้ำ");
  assert.equal(posts(MODELS.imageFast).length, before.img);
  // clef ที่เพิ่มมามีแค่การเลือกเพลง (ขั้นหลัง render)
  assert.ok(clefs().slice(before.clef).every((c) => !c.body.questions[STAGING_KEY]));
  const w = r.motion.warnings.join("\n");
  for (const n of [1, 2, 3, 4]) assert.match(w, new RegExp(`ฉาก ${n}:`));
});

test("motion: render ได้ไฟล์ว่าง → INTERNAL", async () => {
  setRunner(stubRunner({ renderEmpty: true }));
  await assert.rejects(motion(ARGS), (e) => e.code === "INTERNAL" && /render/.test(e.message));
});

test("motion: story ผิดรูป → ส่ง issue กลับให้ LLM แก้ (validate retry)", async () => {
  setRunner(stubRunner());
  const good = STORY();
  storyQueue = [{ ...good, beats: good.beats.slice(0, 3) }];
  const r = await motion(ARGS);
  assert.ok(fs.existsSync(r.motion.file));
  const storyCalls = posts(MODELS.llm[0]).filter((c) => c.body.input.systemInstruction.parts[0].text.includes(STORY_MARK));
  assert.equal(storyCalls.length, 2);
  assert.match(JSON.stringify(storyCalls[1].body.input.contents), /beats must be exactly 5/);
});

test("motion --dry-run: LLM 2, TTS ≈ ความยาว, clef ≈ ฉาก + สถานที่, เพลงสูงสุด; ไม่เรียก API", async () => {
  const d = await motion(["demo", "--prompt", "x", "--duration", "60", "--dry-run", "--max-rerolls", "1"]);
  assert.equal(d.dry_run, true);
  const steps = d.planned.map((p) => p.step);
  assert.equal(d.planned.filter((p) => p.model === MODELS.llm[0]).length, 2);
  assert.ok(steps.includes("narration") && steps.includes("qa") && steps.includes("music"));
  assert.equal(d.planned.find((p) => p.step === "qa").count, 12 + 1);
  assert.ok(d.estimated_usd > 0.2 && d.estimated_usd < 0.35, String(d.estimated_usd));
  assert.match(d.warnings.join("\n"), /max-rerolls/);
  await assert.rejects(motion(["demo", "--prompt", "x", "--duration", "10"]), (e) => e.code === "USAGE");
  await assert.rejects(motion(["demo", "--prompt", "x", "--duration", "181"]), (e) => e.code === "USAGE");
  assert.equal(calls.length, 0);
});
