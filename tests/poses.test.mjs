import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cf from "../tools/cf.mjs";
import { MODELS } from "../tools/models.mjs";
import { main as create } from "../tools/project-create.mjs";
import { main as poses } from "../tools/character-poses.mjs";
import { loadPoses, DEFAULT_POSES, TALK_PROMPT } from "../tools/poses.mjs";
import { goodBible } from "./fixtures/bible.mjs";
import { bodyOf } from "./fixtures/body.mjs";

process.env.VF_NO_DOTENV = "1";
const B64 = fs.readFileSync(fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url))).toString("base64");
const ENV = { CLOUDFLARE_AI_ACCOUNT_ID: "acc1", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456" };
const ENV_KEYS = [...Object.keys(ENV), "VF_PROJECTS"];

let root, saved, calls, origWrite, dir, qaBad;
const reply = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });
const klein = () => calls.filter((c) => c.body?.model === MODELS.imageFast);
const clefCalls = () => calls.filter((c) => c.url.includes("clef-omni"));

function install() {
  calls = [];
  cf.setFetch(async (url, init = {}) => {
    const body = bodyOf(url, init);
    calls.push({ url: String(url), body });
    if (String(url).includes("clef-omni")) {
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [
        k, { noul: k === "has_text" || k === "has_people_or_animals" ? 0 : k === "single_character" && qaBad ? 0.1 : 0.9 },
      ]));
      return reply({ answers, usage: { prompt_tokens: 1500 } });
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

test("dry-run ระบุ klein-4b 12 ภาพ + QA 6 ครั้ง และไม่เรียก API", async () => {
  const r = await poses(["demo", "cat", "--dry-run"]);
  assert.equal(r.dry_run, true);
  const img = r.planned.find((p) => p.step === "pose");
  assert.equal(img.model, MODELS.imageFast);
  assert.equal(img.count, 12);
  assert.equal(r.planned.find((p) => p.step === "qa").count, 6);
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
  assert.ok(pose.every((p) => p.includes(style) && p.includes("flat, uniform light cream background")));
  assert.equal(clefCalls().length, 6);
  assert.equal(loadPoses(dir, "dog"), null);
});

test("TALK_PROMPT คงตา คิ้ว น้ำตา หู อุ้งเท้า ไว้เหมือนเดิม และยังห้ามฉากหลัง", () => {
  for (const w of ["eyes", "open or closed", "gaze", "eyebrows", "tears", "ears", "paws", "Change only the mouth", "room, furniture, window or scenery"]) {
    assert.ok(TALK_PROMPT.includes(w), w);
  }
});

test("ตัวละครที่ไม่มี → USAGE; รันซ้ำไม่มี --replace → USAGE มีท่าแล้ว", async () => {
  await assert.rejects(poses(["demo", "ghost", "--foreground"]), (e) => e.code === "USAGE");
  await run(["--poses", "idle"]);
  await assert.rejects(run(), (e) => e.code === "USAGE" && e.message.includes("มีท่าแล้ว"));
  await assert.rejects(run(["--poses", "fly", "--replace"]), (e) => e.code === "USAGE");
});

test("--replace เก็บชุดเดิมไว้ poses-old-* และสร้างชุดใหม่", async () => {
  await run(["--poses", "idle"]);
  fs.writeFileSync(path.join(posesDir(), "marker.txt"), "old");
  const r = await run(["--poses", "idle,sad", "--replace"]);
  assert.deepEqual(r.poses, ["idle", "sad"]);
  const olds = fs.readdirSync(path.join(dir, "characters", "cat")).filter((n) => n.startsWith("poses-old-"));
  assert.equal(olds.length, 1);
  assert.ok(fs.existsSync(path.join(dir, "characters", "cat", olds[0], "marker.txt")));
  assert.ok(!fs.existsSync(path.join(posesDir(), "marker.txt")));
  assert.equal(loadPoses(dir, "cat").names.length, 2);
});

test("ท่าที่ QA ไม่ผ่านถูกเก็บไว้พร้อม warnings และ reroll 1 ครั้ง", async () => {
  qaBad = true;
  const r = await run(["--poses", "idle"]);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].startsWith("idle:"));
  assert.equal(clefCalls().length, 2);
  assert.ok(fs.existsSync(path.join(posesDir(), "idle-talk.png")));
});
