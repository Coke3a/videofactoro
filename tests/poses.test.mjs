import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cf from "../tools/cf.mjs";
import { MODELS } from "../tools/models.mjs";
import { main as create } from "../tools/project-create.mjs";
import { main as poses, parseCustomPoses, pickPoses } from "../tools/character-poses.mjs";
import { loadPoses, DEFAULT_POSES, TALK_PROMPT } from "../tools/poses.mjs";
import { goodBible } from "./fixtures/bible.mjs";
import { bodyOf } from "./fixtures/body.mjs";

process.env.VF_NO_DOTENV = "1";
const B64 = fs.readFileSync(fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url))).toString("base64");
const ENV = { CLOUDFLARE_AI_ACCOUNT_ID: "acc1", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456" };
const ENV_KEYS = [...Object.keys(ENV), "VF_PROJECTS"];

let root, saved, calls, origWrite, dir, qaBad, noul, failTalk;
const reply = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });
const klein = () => calls.filter((c) => c.body?.model === MODELS.imageFast);
const clefCalls = () => calls.filter((c) => c.url.includes("clef-omni"));

function install() {
  calls = [];
  cf.setFetch(async (url, init = {}) => {
    const body = bodyOf(url, init);
    calls.push({ url: String(url), body });
    if (String(url).includes("clef-omni")) {
      // noul[k] = ตัวเลข หรือ array ที่ใช้ทีละค่าต่อการเรียก
      const pick = (k) => (Array.isArray(noul[k]) ? (noul[k].length > 1 ? noul[k].shift() : noul[k][0]) : noul[k]);
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [
        k, { noul: k in noul ? pick(k) : k === "has_text" || k === "has_people_or_animals" || k === "odd_eyes" ? 0 : k === "single_character" && qaBad ? 0.1 : 0.9 },
      ]));
      return reply({ answers, usage: { prompt_tokens: 1500 } });
    }
    if (failTalk && body?.model === MODELS.imageFast && body.input?.prompt?.includes("Edit image 1")) {
      return { ok: false, status: 500, text: async () => "boom" };
    }
    if (body?.model === MODELS.image || body?.model === MODELS.imageFast) return reply({ image: B64 });
    if (body?.model === MODELS.llm[0]) {
      const sys = body.input.systemInstruction.parts[0].text;
      return reply({
        candidates: [{ content: { parts: [{ text: JSON.stringify(sys.includes("story bible") ? goodBible() : {}) }] } }],
        usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 600 },
      });
    }
    throw new Error("unexpected fetch");
  });
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vf-poses-"));
  Object.assign(process.env, ENV, { VF_PROJECTS: root });
  cf.setSleep(async () => {});
  qaBad = false;
  noul = {};
  failTalk = false;
  install();
  origWrite = process.stderr.write;
  process.stderr.write = () => true;
  await create(["--prompt", "แมวกับหมาในครัว", "--name", "demo", "--foreground"]);
  dir = path.join(root, "demo");
  calls.length = 0;
});
afterEach(() => {
  process.stderr.write = origWrite;
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  cf.setFetch((...a) => globalThis.fetch(...a));
  fs.rmSync(root, { recursive: true, force: true });
});

const run = (extra = []) => poses(["demo", "cat", "--foreground", ...extra]);
const posesDir = () => path.join(dir, "characters", "cat", "poses");

test("dry-run ระบุ klein-4b 12 ภาพ + QA 12 ครั้ง (ท่า + ภาพอ้าปาก) และไม่เรียก API", async () => {
  const r = await poses(["demo", "cat", "--dry-run"]);
  assert.equal(r.dry_run, true);
  const img = r.planned.find((p) => p.step === "pose");
  assert.equal(img.model, MODELS.imageFast);
  assert.equal(img.count, 12);
  assert.equal(r.planned.find((p) => p.step === "qa").count, 12);
  assert.equal(calls.length, 0);
});

test("รันจริง: 12 ไฟล์ + poses.json 6 ท่า, talk ใช้ Edit image 1 และไม่มี style_prompt", async () => {
  const r = await run();
  assert.equal(r.character, "cat");
  assert.deepEqual(r.poses, Object.keys(DEFAULT_POSES));
  const files = fs.readdirSync(posesDir()).filter((f) => f.endsWith(".png")).sort();
  assert.equal(files.length, 12);
  assert.ok(files.includes("idle.png") && files.includes("idle-talk.png") && files.includes("run-talk.png"));
  const lp = loadPoses(dir, "cat");
  assert.equal(lp.names.length, 6);
  assert.equal(lp.file("happy", true), path.join(posesDir(), "happy-talk.png"));
  assert.ok(fs.existsSync(lp.file("happy", false)));

  const style = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).style_prompt;
  const prompts = klein().map((c) => c.body.input.prompt);
  const talk = prompts.filter((p) => p.includes("Edit image 1"));
  assert.equal(talk.length, 6);
  assert.ok(talk.every((p) => !p.includes(style)));
  const pose = prompts.filter((p) => !p.includes("Edit image 1"));
  assert.equal(pose.length, 6);
  // พื้นเขียว chroma key และไม่มี style_prompt (style 3D พาฉาก/แสงมาด้วย ตัดพื้นไม่ออก)
  assert.ok(pose.every((p) => !p.includes(style) && p.includes("chroma-key green (#00FF00) background")));
  assert.ok(talk.every((p) => p.includes("green") && !p.includes("cream")));
  // QA ท่า 6 ครั้ง (ภาพเดียว มีคำถามเรื่องตาพร้อมชื่อท่า) + QA ภาพอ้าปาก 6 ครั้ง (ภาพท่า + ภาพอ้าปาก)
  const qa = clefCalls().map((c) => c.body);
  assert.equal(qa.length, 12);
  const poseQa = qa.filter((b) => "odd_eyes" in b.questions);
  assert.equal(poseQa.length, 6);
  assert.ok(poseQa.every((b) => b.images.length === 1));
  assert.ok(poseQa.some((b) => b.questions.odd_eyes.instructions.includes('"sad"')));
  const talkQa = qa.filter((b) => "same_except_mouth" in b.questions);
  assert.equal(talkQa.length, 6);
  assert.ok(talkQa.every((b) => b.images.length === 2 && "mouth_more_open" in b.questions));
  const pj = JSON.parse(fs.readFileSync(path.join(posesDir(), "poses.json"), "utf8"));
  assert.equal(pj.poses.idle.talk_passed, true);
  assert.ok(Math.abs(pj.poses.idle.talk_score - 1.8) < 1e-9);
  assert.equal(r.warnings, undefined);
  assert.equal(loadPoses(dir, "dog"), null);
});

test("ท่าตาแปลก → reroll และเก็บภาพตาปกติ", async () => {
  noul = { odd_eyes: [0.9, 0.1] };
  const r = await run(["--poses", "curious"]);
  assert.equal(r.warnings, undefined);
  const pose = klein().filter((c) => !c.body.input.prompt.includes("Edit image 1"));
  assert.equal(pose.length, 2);
  const pj = JSON.parse(fs.readFileSync(path.join(posesDir(), "poses.json"), "utf8"));
  assert.equal(pj.poses.curious.passed, true);
});

test("ภาพอ้าปากตาไม่ตรง → สร้างใหม่ seed ใหม่ ≤2 ครั้ง แล้วเก็บดีสุดพร้อม warning", async () => {
  noul = { same_except_mouth: [0.2, 0.3, 0.1] };
  const r = await run(["--poses", "sad"]);
  const talk = klein().filter((c) => c.body.input.prompt.includes("Edit image 1"));
  assert.equal(talk.length, 3);
  assert.equal(new Set(talk.map((c) => JSON.stringify(c.body.input.seed))).size, 3);
  assert.equal(clefCalls().length, 1 + 3);
  assert.deepEqual(r.warnings, [`sad (talk): ไม่มีภาพผ่านเกณฑ์ QA — ใช้ภาพคะแนนสูงสุด`]);
  const pj = JSON.parse(fs.readFileSync(path.join(posesDir(), "poses.json"), "utf8"));
  assert.equal(pj.poses.sad.talk_passed, false);
  assert.ok(Math.abs(pj.poses.sad.talk_score - (0.3 + 0.9)) < 1e-9);
  assert.ok(fs.existsSync(path.join(posesDir(), "sad-talk.png")));
});

test("ภาพอ้าปากผ่านใน reroll ครั้งแรก → หยุดที่ 2 ภาพ", async () => {
  noul = { same_except_mouth: [0.2, 0.9] };
  const r = await run(["--poses", "idle"]);
  assert.equal(r.warnings, undefined);
  assert.equal(klein().filter((c) => c.body.input.prompt.includes("Edit image 1")).length, 2);
});

test("TALK_PROMPT คงตา คิ้ว หู อุ้งเท้า ไว้เหมือนเดิม ไม่เอ่ยถึงน้ำตา และยังห้ามฉากหลัง", () => {
  for (const w of ["eyes", "open or closed", "gaze", "eyebrows", "ears", "paws", "Change only the mouth", "room, furniture, window or scenery"]) {
    assert.ok(TALK_PROMPT.includes(w), w);
  }
  assert.ok(!/tear/i.test(TALK_PROMPT), "ไม่เอ่ยถึงน้ำตา");
});

test("ตัวละครที่ไม่มี → USAGE; รันซ้ำไม่มี --replace → USAGE มีท่าแล้ว", async () => {
  await assert.rejects(poses(["demo", "ghost", "--foreground"]), (e) => e.code === "USAGE");
  await run(["--poses", "idle"]);
  await assert.rejects(run(), (e) => e.code === "USAGE" && e.message.includes("มีท่าแล้ว"));
  await assert.rejects(run(["--poses", "fly", "--replace"]), (e) => e.code === "USAGE");
});

const olds = () => fs.readdirSync(path.join(dir, "characters", "cat")).filter((n) => n.startsWith("poses-old-"));
const oldDir = () => path.join(dir, "characters", "cat", olds()[0]);
const readPj = () => JSON.parse(fs.readFileSync(path.join(posesDir(), "poses.json"), "utf8"));

test("--replace ไม่มี --poses: เก็บทั้งชุดไว้ poses-old-* และสร้างใหม่ทั้งชุด", async () => {
  await run(["--poses", "idle"]);
  fs.writeFileSync(path.join(posesDir(), "marker.txt"), "old");
  const r = await run(["--replace"]);
  assert.deepEqual(r.poses, Object.keys(DEFAULT_POSES));
  assert.equal(olds().length, 1);
  assert.ok(fs.existsSync(path.join(oldDir(), "marker.txt")));
  assert.ok(fs.existsSync(path.join(oldDir(), "idle.png")));
  assert.ok(!fs.existsSync(path.join(posesDir(), "marker.txt")));
  assert.equal(loadPoses(dir, "cat").names.length, 6);
});

test("--replace --poses: เก็บเฉพาะไฟล์ท่าที่ระบุ แล้วรวมเข้า poses.json เดิม ท่าอื่นไม่ถูกแตะ", async () => {
  await run(["--poses", "idle,sad"]);
  for (const f of ["idle.png", "idle-talk.png", "sad.png", "sad-talk.png"]) fs.writeFileSync(path.join(posesDir(), f), `OLD ${f}`);
  fs.writeFileSync(path.join(posesDir(), "marker.txt"), "old");
  const before = readPj();
  calls.length = 0;
  const r = await run(["--poses", "idle,happy", "--replace"]);
  assert.deepEqual(r.poses, ["idle", "sad", "happy"]);
  // seed ใหม่ (ไม่ใช้ cache) → เรียก klein จริงสำหรับ idle และ happy (ท่า + อ้าปาก)
  assert.equal(klein().length, 4);
  assert.equal(olds().length, 1);
  assert.deepEqual(fs.readdirSync(oldDir()).sort(), ["idle-talk.png", "idle.png", "poses.json"]);
  assert.equal(fs.readFileSync(path.join(oldDir(), "idle.png"), "utf8"), "OLD idle.png");
  assert.equal(fs.readFileSync(path.join(posesDir(), "sad.png"), "utf8"), "OLD sad.png");
  assert.equal(fs.readFileSync(path.join(posesDir(), "sad-talk.png"), "utf8"), "OLD sad-talk.png");
  assert.notEqual(fs.readFileSync(path.join(posesDir(), "idle.png"), "utf8").slice(0, 3), "OLD");
  assert.ok(fs.existsSync(path.join(posesDir(), "marker.txt")));
  const pj = readPj();
  assert.deepEqual(Object.keys(pj.poses), ["idle", "sad", "happy"]);
  assert.deepEqual(pj.poses.sad, before.poses.sad);
});

test("--replace --poses ที่ล้มกลางทางรันซ้ำได้ เก็บของเดิมครั้งเดียวและรวมครบ", async () => {
  await run(["--poses", "idle,sad"]);
  failTalk = true;
  await assert.rejects(run(["--poses", "idle", "--replace"]), (e) => e.code === "PROVIDER");
  assert.equal(olds().length, 1);
  failTalk = false;
  const r = await run(["--poses", "idle", "--replace"]);
  assert.deepEqual(r.poses, ["idle", "sad"]);
  assert.equal(olds().length, 1);
  assert.deepEqual(fs.readdirSync(oldDir()).sort(), ["idle-talk.png", "idle.png", "poses.json"]);
  assert.deepEqual(Object.keys(readPj().poses), ["idle", "sad"]);
  assert.ok(fs.existsSync(path.join(posesDir(), "idle-talk.png")));
});

test("ท่าที่ QA ไม่ผ่านถูกเก็บไว้พร้อม warnings และ reroll 1 ครั้ง", async () => {
  qaBad = true;
  const r = await run(["--poses", "idle"]);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].startsWith("idle:"));
  assert.equal(clefCalls().length, 2 + 1);
  assert.ok(fs.existsSync(path.join(posesDir(), "idle-talk.png")));
});

test("parseCustomPoses/pickPoses: ชื่อ=ท่า, ชื่อผิด → USAGE, --pose อย่างเดียว = เฉพาะท่านั้น, รวมกับ --poses ได้", () => {
  assert.deepEqual(parseCustomPoses(["pushup=doing a push-up on the floor", "scared = flinching back"]), {
    pushup: "doing a push-up on the floor", scared: "flinching back",
  });
  for (const bad of ["pushup", "=x", "Push=x", "1up=x", "pushup="]) {
    assert.throws(() => parseCustomPoses([bad]), (e) => e.code === "USAGE", bad);
  }
  assert.deepEqual(pickPoses(undefined, { pushup: "a" }), { pushup: "a" });
  assert.equal(pickPoses(undefined, {}), DEFAULT_POSES);
  // ท่ามาตรฐานที่เขียนใหม่ใช้คำของผู้ใช้
  assert.deepEqual(pickPoses("idle,scared", { scared: "b" }), { idle: DEFAULT_POSES.idle, scared: "b" });
});

test("--pose เพิ่มท่าใหม่เข้าชุดเดิมโดยไม่ต้อง --replace ใช้ท่าทางที่กำหนด; ชื่อซ้ำ → USAGE", async () => {
  await run(["--poses", "idle"]);
  calls.length = 0;
  const r = await run(["--pose", "pushup=doing a push-up on the floor"]);
  assert.deepEqual(r.poses, ["idle", "pushup"]);
  const pose = klein().map((c) => c.body.input.prompt).filter((p) => !p.includes("Edit image 1"));
  assert.equal(pose.length, 1);
  assert.ok(pose[0].includes("doing a push-up on the floor"));
  assert.equal(olds().length, 0);
  assert.deepEqual(Object.keys(readPj().poses), ["idle", "pushup"]);
  await assert.rejects(run(["--pose", "pushup=again"]), (e) => e.code === "USAGE" && e.message.includes("pushup"));
  // เพิ่มอีกท่าได้หลังรอบก่อนจบ (state ถูกหมุน)
  const r2 = await run(["--pose", "plank=holding a plank"]);
  assert.deepEqual(r2.poses, ["idle", "pushup", "plank"]);
});

test("--replace --pose: เขียนท่ามาตรฐานใหม่ เก็บเฉพาะไฟล์ท่านั้นไว้ poses-old-*", async () => {
  await run(["--poses", "idle,scared"]);
  const r = await run(["--replace", "--pose", "scared=flinching back, hands up"]);
  assert.deepEqual(r.poses, ["idle", "scared"]);
  assert.equal(olds().length, 1);
  assert.deepEqual(fs.readdirSync(oldDir()).sort(), ["poses.json", "scared-talk.png", "scared.png"]);
});
