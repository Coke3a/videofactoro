import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cf from "../tools/cf.mjs";
import { MODELS } from "../tools/models.mjs";
import { main as create } from "../tools/project-create.mjs";
import { main as prop } from "../tools/prop-add.mjs";
import { main as show } from "../tools/project-show.mjs";
import { listProps, opaqueBox, PROP_ID_RE } from "../tools/props.mjs";
import { execFileSync } from "node:child_process";
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vf-props-"));
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


const run = (extra = []) => prop(["demo", "--prompt", "robot vacuum", "--foreground", ...extra]);

test("dry-run: klein-4b 1 ภาพ ไม่มี QA และไม่เรียก API", async () => {
  const r = await prop(["demo", "--prompt", "a robot vacuum", "--dry-run"]);
  assert.equal(r.dry_run, true);
  assert.equal(r.planned.find((p) => p.step === "prop").model, MODELS.imageFast);
  assert.equal(calls.length, 0);
});

test("รันจริง: props/robot-vacuum/prop.png + prop.json, prompt มี style_prompt", async () => {
  const r = await run();
  assert.equal(r.id, "robot-vacuum");
  assert.equal(r.file, "props/robot-vacuum/prop.png");
  const d = path.join(dir, "props", "robot-vacuum");
  assert.ok(fs.existsSync(path.join(d, "prop.png")));
  const j = JSON.parse(fs.readFileSync(path.join(d, "prop.json"), "utf8"));
  assert.equal(j.id, "robot-vacuum");
  assert.equal(j.desc, "robot vacuum");
  assert.ok(j.created);
  const style = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).style_prompt;
  assert.equal(klein().length, 1);
  const p = klein()[0].body.input.prompt;
  assert.ok(p.startsWith("robot vacuum. A single object"), p);
  assert.ok(p.includes(style), p);
  assert.equal(clefCalls().length, 0);
  assert.deepEqual(listProps(dir), [{
    id: "robot-vacuum", desc: "robot vacuum", file: "props/robot-vacuum/prop.png",
    placement: "upright", size_cm: null, aspect: 1, trimmed: false,
  }]);
});

test("--id ใช้แทนค่าเริ่มต้น; id ซ้ำ → USAGE; id ไม่ถูกต้อง → USAGE", async () => {
  await run(["--id", "vac"]);
  assert.ok(fs.existsSync(path.join(dir, "props", "vac", "prop.png")));
  await assert.rejects(run(["--id", "vac"]), (e) => e.code === "USAGE");
  await assert.rejects(run(["--id", "Bad Id"]), (e) => e.code === "USAGE");
  await assert.rejects(prop(["demo", "--prompt", "ลูกบอลสีแดง", "--foreground"]), (e) => e.code === "USAGE" && e.message.includes("--id"));
  assert.ok(PROP_ID_RE.test("vac"));
});

test("listProps ไม่มีโฟลเดอร์ → []; vf project show มี props", async () => {
  assert.deepEqual(listProps(dir), []);
  assert.deepEqual((await show(["demo"])).props, []);
  await run();
  assert.deepEqual((await show(["demo"])).props.map((p) => p.id), ["robot-vacuum"]);
});

test("listProps ข้าม prop.json ที่เสีย ไม่ throw", async () => {
  await run(["--id", "good"]);
  await run(["--id", "bad"]);
  fs.writeFileSync(path.join(dir, "props", "bad", "prop.json"), "{not json");
  assert.deepEqual(listProps(dir).map((p) => p.id), ["good"]);
});

// รูปจริง 40×100 ทึบเฉพาะกลาง 20×80 (ขอบใส 10 px): ffmpeg สร้างจาก lavfi เพื่อไม่ต้องมีไฟล์ fixture
function productPng(file) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=20x80,format=rgba",
    "-f", "lavfi", "-i", "color=c=black@0.0:s=40x100,format=rgba",
    "-filter_complex", "[1][0]overlay=10:10,format=rgba", "-frames:v", "1", file]);
  return file;
}

test("opaqueBox: กรอบของพิกเซลทึบ; โปร่งทั้งภาพ → null", () => {
  const w = 4, h = 3, px = Buffer.alloc(w * h * 4);
  px[(1 * w + 2) * 4 + 3] = 255;
  px[(2 * w + 1) * 4 + 3] = 255;
  assert.deepEqual(opaqueBox({ w, h, px }), { x: 1, y: 1, w: 2, h: 2 });
  assert.equal(opaqueBox({ w, h, px: Buffer.alloc(w * h * 4) }), null);
});

test("--image: ไม่เรียก API, ตัดขอบใส, floor หมุนด้านยาวเป็นแนวนอน, prop.json มี placement/size_cm/aspect", async () => {
  const img = productPng(path.join(root, "mat.png"));
  const r = await run(["--id", "mat", "--image", img, "--placement", "floor", "--size-cm", "185"]);
  assert.equal(r.placement, "floor");
  assert.equal(r.size_cm, 185);
  assert.equal(r.aspect, 4);
  assert.equal(r.cost.usd, 0);
  assert.equal(calls.length, 0);
  const size = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", path.join(dir, "props", "mat", "prop.png")]).toString().trim();
  assert.equal(size, "80,20");
  const [p] = listProps(dir);
  assert.equal(p.placement, "floor");
  assert.equal(p.trimmed, true);
});

test("--image upright คงทิศเดิม; --placement/--size-cm ผิด → USAGE; ไม่มี --image แต่ใส่ --placement → USAGE", async () => {
  const img = productPng(path.join(root, "box.png"));
  const r = await run(["--id", "box", "--image", img]);
  assert.equal(r.placement, "upright");
  assert.equal(r.aspect, 0.25);
  await assert.rejects(run(["--id", "b2", "--image", img, "--placement", "wall"]), (e) => e.code === "USAGE");
  await assert.rejects(run(["--id", "b3", "--image", img, "--size-cm", "-5"]), (e) => e.code === "USAGE");
  await assert.rejects(run(["--id", "b4", "--placement", "floor"]), (e) => e.code === "USAGE");
});
