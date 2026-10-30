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
import { main as motion, SCENES_MAX_TOKENS } from "../tools/motion.mjs";
import { setRunner } from "../tools/hf.mjs";
import { validateScenePlan, validateStory } from "../tools/motion-plan.mjs";
import { SFX_KINDS } from "../tools/fx.mjs";
import { goodBible } from "./fixtures/bible.mjs";
import { bodyOf } from "./fixtures/body.mjs";
import { POSE_KEY } from "../tools/motion-check.mjs";
import { TINY, STORY, SCENES, SILENT_SCENES, STORY_MARK, SCENES_MARK, STAGING_KEY, prepareMotionProject, stubRunner } from "./fixtures/motion.mjs";

const B64 = fs.readFileSync(TINY).toString("base64");
const ENV = { CLOUDFLARE_AI_ACCOUNT_ID: "acc1", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456" };
const ENV_KEYS = [...Object.keys(ENV), "VF_PROJECTS", "VF_HF_FONT"];

let WAV, MP3, FONT, root, dir, saved, calls, origWrite, staging, poseScore, story, storyQueue, scenes;
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
  poseScore = 0.1;
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
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { noul: k === STAGING_KEY ? staging : k === POSE_KEY ? poseScore : /text/.test(k) || k === "has_people_or_animals" ? 0 : 0.9 }]));
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
  for (const f of ["hf/index.html", "plan.json", "video.mp4", "hf/vendor/gsap.min.js", "hf/fonts/Test-Bold.ttf", "voice-1-1.wav", "voice-4-2.wav",
    "hf/assets/plate-kitchen.jpg", "hf/assets/cat-idle.png", "hf/assets/cat-happy-talk.png", "hf/assets/prop-ball.png"]) {
    assert.ok(fs.existsSync(path.join(m.dir, f)), f);
  }
  // โฟลเดอร์ของ HyperFrames มีแต่ composition (เสียง/วิดีโออยู่ชั้นนอก)
  assert.deepEqual(fs.readdirSync(path.join(m.dir, "hf")).sort(), ["assets", "fonts", "index.html", "vendor"]);
  for (const a of runner.seen) assert.equal(a[1], path.join(m.dir, "hf"), `hyperframes ${a[0]} ได้โฟลเดอร์ hf/`);
  // temp ของ hyperframes อยู่ใต้ motions/<id>/.tmp ทุกคำสั่ง และถูกลบหลัง render สำเร็จ
  const tmp = path.join(m.dir, ".tmp");
  assert.equal(runner.envs.length, runner.seen.length);
  for (const e of runner.envs) for (const k of ["TMPDIR", "TMP", "TEMP"]) assert.equal(e[k], tmp, k);
  assert.ok(!fs.existsSync(tmp), "ลบ .tmp หลัง render สำเร็จ");
  assert.ok(fs.existsSync(path.join(dir, "props", "ball", "prop.png")), "prop ใหม่ถูกสร้างก่อนวางแผนฉาก");
  const html = fs.readFileSync(path.join(m.dir, "hf", "index.html"), "utf8");
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
  // skill video-gen ของ Hermes อ่าน characters/title/summary จาก plan.json
  assert.deepEqual(plan.characters, ["cat", "dog"]);
  assert.equal(plan.title, "Ball Panic");
  assert.equal(plan.summary, "The cat and the dog chase a red ball.");
  assert.ok(fs.readFileSync(path.join(dir, "EPISODES.md"), "utf8").includes("| motion | Ball Panic |"));
  assert.ok(r.cost.usd > 0);
  await assert.rejects(motion(ARGS), (e) => e.code === "USAGE" && /เสร็จแล้ว/.test(e.message));
});

test("motion: แผนฉากขอ maxTokens SCENES_MAX_TOKENS ส่วน story ยัง 4000", async () => {
  setRunner(stubRunner());
  await motion(ARGS);
  // คลิปสองถูกตัดที่ 12000 ครั้งหนึ่ง (14 ฉาก + thinking ของ Gemini)
  assert.equal(SCENES_MAX_TOKENS, 24000);
  const llm = posts(MODELS.llm[0]);
  const max = (mark) => llm.find((c) => c.body.input.systemInstruction.parts[0].text.includes(mark)).body.input.generationConfig.maxOutputTokens;
  const headroom = max(STORY_MARK) - 4000;
  assert.ok(headroom >= 0);
  assert.equal(max(SCENES_MARK), SCENES_MAX_TOKENS + headroom);
});

test("motion --id: ใช้เป็น id ของคลิปและชื่อไฟล์ render; id ผิดรูป → USAGE", async () => {
  setRunner(stubRunner());
  const r = await motion([...ARGS, "--id", "cheese-chase-v2"]);
  assert.equal(r.motion.id, "cheese-chase-v2");
  assert.equal(r.motion.file, path.join(dir, "renders", "cheese-chase-v2.mp4"));
  assert.equal(r.motion.dir, path.join(dir, "motions", "cheese-chase-v2"));
  assert.ok(fs.existsSync(r.motion.file));
  const n = calls.length;
  for (const bad of ["Cheese_Chase", "9lives", "x"]) {
    await assert.rejects(motion([...ARGS, "--id", bad]), (e) => e.code === "USAGE" && /--id/.test(e.message), bad);
  }
  assert.equal(calls.length, n, "id ผิดรูปไม่เรียก API");
});

test("motion: ตัวละครที่ยังไม่มีท่า → USAGE บอกคำสั่ง ไม่เรียก API เลย", async () => {
  setRunner(stubRunner());
  fs.rmSync(path.join(dir, "characters", "dog", "poses"), { recursive: true });
  await assert.rejects(motion(ARGS), (e) => e.code === "USAGE" && e.message.includes("ยังไม่มีท่าของตัวละคร") && e.message.includes("vf character poses demo dog"));
  await assert.rejects(motion([...ARGS.slice(0, -1)]), (e) => e.code === "USAGE", "background ก็ต้องปฏิเสธก่อนเริ่ม job");
  assert.equal(calls.length, 0);
});

test("motion: poses.json ชี้ไฟล์ที่ถูก archive ไปแล้ว → USAGE บอกคำสั่ง ไม่ใช่ ENOENT", async () => {
  setRunner(stubRunner());
  const pd = path.join(dir, "characters", "dog", "poses");
  for (const f of fs.readdirSync(pd)) if (f.endsWith(".png")) fs.rmSync(path.join(pd, f));
  await assert.rejects(motion(ARGS), (e) => e.code === "USAGE" && e.message.includes("vf character poses demo dog"));
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
  // story + scenes + pose-fix (เฉพาะเมื่อ clef พบท่าไม่ตรงบท)
  assert.equal(d.planned.filter((p) => p.model === MODELS.llm[0]).length, 3);
  assert.ok(steps.includes("narration") && steps.includes("qa") && steps.includes("music"));
  // ฉากละ 3.5 วินาที → 17 ฉาก: กลางฉาก 17 + สถานที่ 1 + ท่ากับบท ~2 บทต่อฉาก
  assert.equal(d.planned.find((p) => p.step === "qa").count, 17 + 1 + 17 * 2);
  assert.ok(d.estimated_usd > 0.2 && d.estimated_usd < 0.35, String(d.estimated_usd));
  assert.match(d.warnings.join("\n"), /max-rerolls/);
  await assert.rejects(motion(["demo", "--prompt", "x", "--duration", "10"]), (e) => e.code === "USAGE");
  await assert.rejects(motion(["demo", "--prompt", "x", "--duration", "181"]), (e) => e.code === "USAGE");
  assert.equal(calls.length, 0);
});

const llmTts = () => posts(MODELS.llm[0]).length + posts(MODELS.tts).length;

test("motion: project narrator false → prompt บอกว่าไม่มีผู้บรรยาย และไม่มีเสียงผู้บรรยาย", async () => {
  setRunner(stubRunner());
  const f = path.join(dir, "project.json");
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), narrator: false }));
  scenes = SCENES({ narrator: false });
  const r = await motion(ARGS);
  assert.ok(fs.existsSync(r.motion.file));
  const sys = posts(MODELS.llm[0]).map((c) => c.body.input.systemInstruction.parts[0].text).find((t) => t.includes(SCENES_MARK));
  assert.match(sys, /There is no narrator/);
  assert.equal(posts(MODELS.tts).filter((c) => c.body.input.voice === "Kore").length, 0);
});

test("motion: cutout ของ prop พัง → รันซ้ำไม่จ่ายค่าภาพ prop ซ้ำ", async () => {
  setRunner(stubRunner());
  const blocker = path.join(dir, "props", "ball");
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(blocker, "not a dir"); // mkdir ของขั้น cut พัง
  await assert.rejects(motion(ARGS));
  assert.equal(posts(MODELS.imageFast).length, 1);
  const sf = fs.readdirSync(path.join(dir, ".vf")).find((f) => f.startsWith("motion2-"));
  const st = JSON.parse(fs.readFileSync(path.join(dir, ".vf", sf), "utf8"));
  assert.equal(st["props/ball/prop:gen"].status, "done", "ภาพ prop ถูก checkpoint แยก");
  assert.equal(st["props/ball/prop:cut"].status, "failed");
  fs.rmSync(blocker);
  const r = await motion(ARGS);
  assert.ok(fs.existsSync(path.join(dir, "props", "ball", "prop.png")));
  assert.equal(posts(MODELS.imageFast).length, 1, "ไม่สร้างภาพ prop ใหม่");
  assert.ok(fs.existsSync(r.motion.file));
});

test("motion: ไม่มีบทพูดเลยทุกฉาก → ไม่มีรางพากย์ แต่คลิปเสร็จ ยาวตามฉาก", async () => {
  setRunner(stubRunner());
  scenes = SILENT_SCENES();
  const r = await motion(ARGS);
  assert.equal(posts(MODELS.tts).length, 0);
  assert.equal(r.motion.narration, false);
  assert.equal(r.motion.sfx, true);
  assert.ok(Math.abs(r.motion.seconds - 21) < 0.01);
  assert.ok(Math.abs(Number(probe(r.motion.file).format.duration) - 21) < 0.3);
});

test("motion: lint พังครั้งแรก → รันซ้ำ compose ใหม่จากแผนเดิม ไม่เรียก LLM/TTS", async () => {
  let bad = true;
  const ok = stubRunner();
  const runner = async (args, o) => (args[0] === "lint" && bad ? { stdout: "◇  1 error(s), 0 warning(s)" } : ok(args, o));
  setRunner(runner);
  await assert.rejects(motion(ARGS), (e) => e.code === "INTERNAL");
  const n = llmTts();
  const html = path.join(dir, "motions", fs.readdirSync(path.join(dir, "motions"))[0], "hf", "index.html");
  fs.writeFileSync(html, "stale");
  bad = false;
  const r = await motion(ARGS);
  assert.ok(fs.existsSync(r.motion.file));
  assert.match(fs.readFileSync(html, "utf8"), /data-composition-id="main"/, "compose ใหม่ ไม่ใช้ HTML เดิมที่ lint ไม่ผ่าน");
  assert.equal(llmTts(), n, "ไม่เรียก LLM/TTS ใหม่");
  assert.ok(ok.seen.some((a) => a[0] === "lint"));
});

test("motion: ท่าที่แผนใช้หายไปก่อน compose → USAGE บอกตัวละคร/ท่า และคำสั่ง", async () => {
  let bad = true;
  const ok = stubRunner();
  setRunner(async (args, o) => (args[0] === "lint" && bad ? { stdout: "◇  1 error(s), 0 warning(s)" } : ok(args, o)));
  await assert.rejects(motion(ARGS), (e) => e.code === "INTERNAL");
  const pf = path.join(dir, "characters", "cat", "poses", "poses.json");
  const pj = JSON.parse(fs.readFileSync(pf, "utf8"));
  delete pj.poses.happy;
  fs.writeFileSync(pf, JSON.stringify(pj));
  bad = false;
  await assert.rejects(motion(ARGS), (e) => e.code === "USAGE" && /cat/.test(e.message) && /happy/.test(e.message) && e.message.includes("vf character poses demo cat"));
});

test("motion: beat ว่างจาก LLM ถูกตัดก่อน validate และไม่อยู่ใน plan.json", async () => {
  scenes.scenes[0].beats = [...(scenes.scenes[0].beats ?? []), { at: "1" }, { at: "2", text: "x" }];
  setRunner(stubRunner());
  const r = await motion([...ARGS, "--no-reuse"]);
  const plan = JSON.parse(fs.readFileSync(path.join(r.motion.dir, "plan.json"), "utf8"));
  for (const sc of plan.scenes) for (const b of sc.beats) assert.ok(b.pose || b.move || b.fx || b.sfx);
  assert.equal(calls.filter((c) => c.body?.input?.systemInstruction?.parts?.[0]?.text?.includes(SCENES_MARK)).length, 1);
});

test("motion: clef พบท่าไม่ตรงบท → LLM แก้ท่า 1 รอบ (บทเดิม ไม่อัดเสียงใหม่) → ตรวจซ้ำ → plan.json เป็นแผนที่แก้", async () => {
  poseScore = 0.9;
  setRunner(stubRunner());
  const r = await motion([...ARGS, "--no-reuse"]);
  // story + scenes + fix
  assert.equal(posts(MODELS.llm[0]).length, 3);
  const fix = calls.filter((c) => JSON.stringify(c.body ?? {}).includes("Problems found by checking the picture"));
  assert.equal(fix.length, 1);
  // ตรวจซ้ำแล้วยังไม่ผ่าน (stub ให้ 0.9 ตลอด) → เตือน
  assert.ok(r.motion.warnings.some((w) => /หลังแก้แล้ว/.test(w)), r.motion.warnings.join("\n"));
  const plan = JSON.parse(fs.readFileSync(path.join(r.motion.dir, "plan.json"), "utf8"));
  assert.equal(plan.hook, "Who gets the ball?");
});
