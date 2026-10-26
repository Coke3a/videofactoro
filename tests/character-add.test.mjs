import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as cf from "../tools/cf.mjs";
import { MODELS } from "../tools/models.mjs";
import { libLoad } from "../tools/cache.mjs";
import { readCosts, summarize } from "../tools/cost.mjs";
import { waitJob } from "../tools/jobs.mjs";
import { main as create } from "../tools/project-create.mjs";
import { main as charAdd } from "../tools/character-add.mjs";
import { main as placeAdd } from "../tools/place-add.mjs";
import { addCharacterFiles } from "../tools/bible.mjs";
import { commitStagedRefs } from "../tools/entities.mjs";
import { RULES } from "../tools/qa-rules.mjs";
import { validateCharacter, validatePlace } from "../tools/bible.mjs";
import { goodBible } from "./fixtures/bible.mjs";
import { bodyOf } from "./fixtures/body.mjs";

process.env.VF_NO_DOTENV = "1";
const TINY = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
const B64 = fs.readFileSync(TINY).toString("base64");
const ENV = {
  CLOUDFLARE_AI_ACCOUNT_ID: "acc1", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456",
};
const ENV_KEYS = [...Object.keys(ENV), "VF_PROJECTS"];
const HERON = "A tall slender grey heron with a long yellow beak, white chest feathers, thin dark legs, and a small green satchel across the body; always the same proportions.";
const heron = (o = {}) => ({
  id: "heron", name: "นกกระยาง", role: "ที่ปรึกษา", look: HERON, personality: "สุขุม",
  voice_description: "เสียงนุ่ม", tts_voice: "Kore", ...o,
});

let root, saved, calls, origWrite, bible, llmChar, llmPlace, failMatch, qaBad, dir;
const reply = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });
const imageCalls = () => calls.filter((c) => c.body?.model === MODELS.image);
const llmCalls = () => calls.filter((c) => c.body?.model === MODELS.llm[0]);
const clefCalls = () => calls.filter((c) => c.url.includes("clef-omni"));
const asText = (c) => JSON.stringify(c.body);

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
    if (body?.model === MODELS.image) {
      if (failMatch && body.input.prompt.includes(failMatch)) throw new Error("เครือข่ายล่ม");
      return reply({ image: B64 });
    }
    if (body?.model === MODELS.llm[0]) {
      const sys = body.input.systemInstruction.parts[0].text;
      const data = sys.includes("story bible") ? bible : sys.includes("สถานที่ใหม่") ? llmPlace : llmChar;
      return reply({
        candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }],
        usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 600 },
      });
    }
    throw new Error("unexpected fetch");
  });
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vf-cadd-"));
  Object.assign(process.env, ENV, { VF_PROJECTS: root });
  cf.setSleep(async () => {});
  bible = goodBible();
  llmChar = heron();
  llmPlace = { id: "garden", name: "สวน", desc: "A quiet backyard garden with a stone path, tall sunflowers and a wooden fence" };
  failMatch = null;
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

const add = (extra = []) => charAdd(["demo", "--prompt", "นกกระยางที่ปรึกษา", "--foreground", ...extra]);
const pj = () => JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
const jpgOf = (name) => {
  const p = path.join(root, name);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", TINY, p]);
  return p;
};

test("character add เพิ่มแถวในตาราง PROJECT.md โดยไม่แตะข้อความที่เขียนเอง", async () => {
  const mdFile = path.join(dir, "PROJECT.md");
  fs.writeFileSync(mdFile, fs.readFileSync(mdFile, "utf8").replace("## โลก", "ข้อความที่คนเขียนเอง-ห้ามหาย\n\n## โลก"));
  const before = fs.readFileSync(mdFile, "utf8");
  const costBefore = summarize(readCosts(path.join(dir, ".vf"))).totalUsd;
  const nRowsBefore = readCosts(path.join(dir, ".vf")).length;

  const r = await add();
  assert.equal(r.character.id, "heron");
  assert.equal(r.character.ref, "characters/heron/ref/main.png");
  assert.equal(r.character.look, HERON);
  const md = fs.readFileSync(mdFile, "utf8");
  assert.ok(md.includes("ข้อความที่คนเขียนเอง-ห้ามหาย"));
  assert.ok(md.includes("| heron |") && md.includes("| cat |") && md.includes("| dog |"));
  assert.equal(md.split("\n").filter((l) => l.startsWith("| heron |")).length, 1);
  const strip = (t) => t.replace(/<!-- vf:auto:(\w+) -->[\s\S]*?<!-- \/vf:auto:\1 -->/g, "");
  assert.equal(strip(md), strip(before));

  assert.deepEqual(pj().characters.map((c) => c.id), ["cat", "dog", "heron"]);
  for (const f of ["characters/heron/CHARACTER.md", "characters/heron/character.json", "characters/heron/ref/main.png"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "characters/heron/character.json"), "utf8")).ref, "ref/main.png");

  assert.equal(imageCalls().length, 3);
  for (const c of imageCalls()) assert.deepEqual(Object.keys(c.body.input).filter((k) => k.startsWith("input_image_")), ["input_image_0", "input_image_1"]);
  const llm = asText(llmCalls()[0]);
  assert.ok(llm.includes("นกกระยางที่ปรึกษา") && llm.includes("ข้อความที่คนเขียนเอง") && llm.includes("cat") && llm.includes("dog"));
  assert.ok(llmCalls()[0].body.input.systemInstruction.parts[0].text.includes("ภาษา en ยกเว้น look"));

  const lib = libLoad(dir).entries.filter((e) => e.characters.includes("heron"));
  assert.equal(lib.length, 3);
  assert.equal(lib.filter((e) => e.status === "selected").length, 1);
  assert.equal(new Set(lib.map((e) => e.seed)).size, 3);

  const all = summarize(readCosts(path.join(dir, ".vf"))).totalUsd;
  assert.ok(r.cost.usd > 0);
  assert.ok(Math.abs(r.cost.usd - (all - costBefore)) < 1e-9);
  const rows = readCosts(path.join(dir, ".vf")).slice(nRowsBefore);
  assert.ok(rows.length >= 4 && rows.every((x) => typeof x.run === "string" && x.run === rows[0].run));
  assert.ok(!JSON.stringify(r).includes("tok-secret"));
});

test("--id บังคับ id ทับของ LLM และ id ซ้ำไม่มี --replace ได้ USAGE (ไม่ยิง fetch)", async () => {
  llmChar = heron({ id: "whatever" });
  const r = await add(["--id", "heron2"]);
  assert.equal(r.character.id, "heron2");
  assert.ok(fs.existsSync(path.join(dir, "characters/heron2/CHARACTER.md")));
  calls.length = 0;
  await assert.rejects(add(["--id", "cat"]), (e) => e.code === "USAGE" && e.message.includes("cat"));
  await assert.rejects(add(["--id", "kitchen"]), (e) => e.code === "USAGE");
  await assert.rejects(add(["--id", "Bad Id"]), (e) => e.code === "USAGE");
  await assert.rejects(add(["--replace"]), (e) => e.code === "USAGE");
  await assert.rejects(add(["--id", "nobody", "--replace"]), (e) => e.code === "USAGE");
  assert.equal(calls.length, 0);
});

test("validateCharacter/validatePlace ใช้กฎเดียวกับ bible", () => {
  assert.deepEqual(validateCharacter(heron(), new Set()), []);
  assert.ok(validateCharacter(heron({ id: "cat" }), new Set(["cat"])).some((x) => x.includes("ซ้ำ")));
  assert.ok(validateCharacter(heron({ look: "short" }), new Set()).some((x) => x.includes("สั้น")));
  assert.ok(validateCharacter(heron({ tts_voice: "Nope" }), new Set()).some((x) => x.includes("tts_voice")));
  assert.ok(validateCharacter(heron({ name: "Garfield" }), new Set()).some((x) => x.includes("Garfield")));
  assert.ok(validatePlace({ id: "x", name: "n", desc: "d" }, new Set()).some((x) => x.includes("ผิดรูปแบบ")));
  assert.deepEqual(validatePlace(llmPlace, new Set(["kitchen"])), []);
});

test("--image ไม่เรียกโมเดลสร้างภาพเลย", async () => {
  const a = jpgOf("a.jpg");
  const b = path.join(root, "b.png");
  fs.copyFileSync(TINY, b);
  const r = await add(["--image", a, "--image", b]);
  assert.equal(imageCalls().length, 0);
  assert.equal(r.character.ref, "characters/heron/ref/main.png");
  assert.equal(r.character.warning, undefined);
  assert.equal(fs.readFileSync(path.join(dir, "characters/heron/ref/main.png")).readUInt32BE(0), 0x89504e47);
  assert.equal(fs.readFileSync(path.join(dir, "characters/heron/ref/extra-1.png")).readUInt32BE(0), 0x89504e47);
  const llm = llmCalls()[0].body.input;
  const parts = llm.contents[0].parts;
  assert.equal(parts.filter((p) => p.inlineData).length, 2);
  assert.equal(clefCalls().length, 1);
  assert.equal(clefCalls()[0].body.images.length, 1);
  assert.deepEqual(Object.keys(clefCalls()[0].body.questions).sort(), ["has_text", "single_character"]);
  const e = libLoad(dir).entries.filter((x) => x.characters.includes("heron"));
  assert.equal(e.length, 1);
  assert.equal(e[0].status, "selected");
  assert.equal(e[0].need, "user image");
  assert.deepEqual(pj().characters.map((c) => c.id), ["cat", "dog", "heron"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "characters/heron/character.json"), "utf8")).extra_refs, ["ref/extra-1.png"]);
});

test("--image เกิน 4 ภาพ → USAGE, ไฟล์ไม่มี → USAGE, QA ไม่ผ่าน = warning ไม่ใช่ error", async () => {
  await assert.rejects(add(Array(5).fill(["--image", TINY]).flat()), (e) => e.code === "USAGE");
  await assert.rejects(add(["--image", "/no/such.png"]), (e) => e.code === "USAGE");
  assert.equal(calls.length, 0);
  qaBad = true;
  const r = await add(["--image", TINY]);
  assert.equal(r.character.id, "heron");
  assert.ok(r.character.warning.includes("ตัวละครเดี่ยว"));
  assert.ok(fs.existsSync(path.join(dir, "characters/heron/ref/main.png")));
});

test("RULES.characterFromImage: เกณฑ์ 0.7 / 0.3", () => {
  const n = (v) => ({ noul: v });
  const j = (s, t) => RULES.characterFromImage.judge({ single_character: n(s), has_text: n(t) });
  assert.equal(j(0.7, 0.29).pass, true);
  assert.equal(j(0.69, 0).pass, false);
  assert.equal(j(0.9, 0.3).pass, false);
  assert.equal(RULES.characterFromImage.judge({}).pass, false);
  const q = RULES.characterFromImage.questions({});
  assert.deepEqual(q.single_character, RULES.characterRef.questions({ look: "x" }).single_character);
  assert.deepEqual(q.has_text, RULES.characterRef.questions({ look: "x" }).has_text);
});

test("--replace เก็บภาพเก่าไว้", async () => {
  await add();
  const oldBytes = fs.readFileSync(path.join(dir, "characters/heron/ref/main.png"));
  fs.writeFileSync(path.join(dir, "characters/heron/ref/extra-1.png"), "extra");
  await assert.rejects(add(), (e) => e.code === "USAGE");
  const mine = jpgOf("mine.jpg");
  llmChar = heron({ look: HERON.replace("grey", "blue-grey"), role: "ครู" });
  const r = await add(["--id", "heron", "--replace", "--image", mine]);
  assert.equal(r.character.id, "heron");
  const ref = path.join(dir, "characters/heron/ref");
  const olds = fs.readdirSync(ref).filter((n) => n.startsWith("old-"));
  assert.equal(olds.length, 1);
  assert.match(olds[0], /^old-\d{8}-\d{4}/);
  assert.deepEqual(fs.readFileSync(path.join(ref, olds[0], "main.png")), oldBytes);
  assert.equal(fs.readFileSync(path.join(ref, olds[0], "extra-1.png"), "utf8"), "extra");
  assert.deepEqual(fs.readdirSync(ref).filter((n) => !n.startsWith("old-")), ["main.png"]);
  const lib = libLoad(dir).entries.filter((e) => e.characters.includes("heron"));
  assert.equal(lib.filter((e) => e.status === "selected").length, 1);
  assert.equal(lib.filter((e) => e.status === "selected")[0].need, "user image");
  assert.equal(lib.filter((e) => e.status === "replaced").length, 1);
  assert.ok(lib.every((e) => fs.existsSync(path.join(dir, e.blob))));
  assert.equal(pj().characters.length, 3);
  assert.equal(pj().characters.find((c) => c.id === "heron").role, "ครู");
  const md = fs.readFileSync(path.join(dir, "PROJECT.md"), "utf8");
  assert.equal(md.split("\n").filter((l) => l.startsWith("| heron |")).length, 1);
  assert.ok(fs.readFileSync(path.join(dir, "characters/heron/CHARACTER.md"), "utf8").includes("blue-grey"));
  // replace รอบสอง: ไม่ชนชื่อโฟลเดอร์เก่า
  await add(["--id", "heron", "--replace", "--image", TINY]);
  assert.equal(fs.readdirSync(ref).filter((n) => n.startsWith("old-")).length, 2);
});

test("resume: input ต่างไป → USAGE และไม่เรียก LLM ซ้ำเมื่อรันซ้ำ", async () => {
  failMatch = HERON.slice(0, 40);
  await assert.rejects(add(["--id", "heron"]), (e) => {
    assert.match(e.details.resume, /^vf character add /);
    assert.ok(e.details.resume.includes("--id=heron"));
    return e.code === "PROVIDER";
  });
  assert.equal(llmCalls().length, 1);
  failMatch = null;
  const n = calls.length;
  await assert.rejects(charAdd(["demo", "--prompt", "อย่างอื่น", "--id", "heron", "--foreground"]), (e) => e.code === "USAGE");
  await assert.rejects(add(["--id", "heron", "--image", TINY]), (e) => e.code === "USAGE");
  assert.equal(calls.length, n);
  const imgBefore = imageCalls().length;
  const r = await add(["--id", "heron"]);
  assert.equal(llmCalls().length, 1);
  assert.equal(imageCalls().length - imgBefore, 3);
  assert.equal(r.character.id, "heron");
  assert.ok(r.cost.usd >= 0);
  await assert.rejects(add(["--id", "heron"]), (e) => e.code === "USAGE");
});

test("--dry-run ไม่ยิง fetch ไม่เขียนไฟล์ และคืน estimated_usd", async () => {
  const before = fs.readFileSync(path.join(dir, "project.json"), "utf8");
  const r = await add(["--dry-run"]);
  const r2 = await add(["--dry-run", "--image", TINY]);
  const p = await placeAdd(["demo", "--prompt", "x", "--dry-run"]);
  assert.equal(calls.length, 0);
  assert.equal(r.dry_run, true);
  assert.ok(r.estimated_usd > 0 && r2.estimated_usd > 0 && p.estimated_usd > 0);
  assert.equal(r.planned.find((s) => s.step === "character-ref").count, 3);
  assert.ok(!r2.planned.some((s) => s.step === "character-ref"));
  assert.ok(r.assumptions.length >= 2);
  assert.equal(fs.readFileSync(path.join(dir, "project.json"), "utf8"), before);
  assert.ok(!fs.existsSync(path.join(dir, "characters/heron")));
  assert.ok(!fs.existsSync(path.join(dir, ".vf/character-heron-state.json")));
});

test("ไม่มี --foreground คืน job ทันที", async () => {
  delete process.env.CLOUDFLARE_AI_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_AI_API_TOKEN;
  const r = await charAdd(["demo", "--prompt=-ขึ้นต้นด้วยขีด", "--id", "heron"]);
  try {
    assert.ok(r.job.id);
    assert.deepEqual(r.next, [`vf wait demo ${r.job.id}`]);
    assert.equal(calls.length, 0);
  } finally {
    const done = await waitJob(r.job.dir, 30, 100);
    assert.equal(done.status, "failed");
    assert.equal(done.error.code, "CONFIG");
  }
});

test("place add เพิ่มสถานที่ใน project.json, PROJECT.md และสร้างภาพฉาก", async () => {
  const costBefore = summarize(readCosts(path.join(dir, ".vf"))).totalUsd;
  const r = await placeAdd(["demo", "--prompt", "สวนหลังบ้าน", "--foreground"]);
  assert.equal(r.place.id, "garden");
  assert.equal(r.place.plate, "places/garden/plates/main.jpg");
  assert.equal(execFileSync("file", ["-b", path.join(dir, r.place.plate)]).toString().slice(0, 4), "JPEG");
  for (const f of ["places/garden/PLACE.md", "places/garden/place.json"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.deepEqual(pj().places.map((p) => p.id), ["kitchen", "garden"]);
  const md = fs.readFileSync(path.join(dir, "PROJECT.md"), "utf8");
  assert.ok(md.includes("| garden |") && md.includes("| kitchen |"));
  assert.equal(imageCalls().length, 1);
  assert.ok(imageCalls()[0].body.input.prompt.includes("wooden fence"));
  const all = summarize(readCosts(path.join(dir, ".vf"))).totalUsd;
  assert.ok(r.cost.usd > 0 && Math.abs(r.cost.usd - (all - costBefore)) < 1e-9);
  await assert.rejects(placeAdd(["demo", "--prompt", "สวน", "--id", "kitchen", "--foreground"]), (e) => e.code === "USAGE");
  await assert.rejects(placeAdd(["demo", "--prompt", "สวน", "--id", "cat", "--foreground"]), (e) => e.code === "USAGE");
  llmPlace = { ...llmPlace, id: "yard" };
  const r2 = await placeAdd(["demo", "--prompt", "ลานบ้าน", "--id", "orchard", "--foreground"]);
  assert.equal(r2.place.id, "orchard");
});

test("--replace ที่สร้างภาพล้มเหลว: ภาพเก่ายังอยู่และ project.json ยังสอดคล้อง", async () => {
  await add();
  const ref = path.join(dir, "characters/heron/ref");
  const oldBytes = fs.readFileSync(path.join(ref, "main.png"));
  const oldMd = fs.readFileSync(path.join(dir, "characters/heron/CHARACTER.md"), "utf8");
  const pjBefore = fs.readFileSync(path.join(dir, "project.json"), "utf8");
  llmChar = heron({ role: "ครู" });
  failMatch = HERON.slice(0, 40);
  await assert.rejects(add(["--id", "heron", "--replace"]), (e) => e.code === "PROVIDER" && /--replace/.test(e.details.resume));
  assert.deepEqual(fs.readFileSync(path.join(ref, "main.png")), oldBytes);
  assert.deepEqual(fs.readdirSync(ref).filter((n) => n.startsWith("old-")), []);
  assert.equal(fs.readFileSync(path.join(dir, "project.json"), "utf8"), pjBefore);
  assert.equal(fs.readFileSync(path.join(dir, "characters/heron/CHARACTER.md"), "utf8"), oldMd);
  const sel = libLoad(dir).entries.filter((e) => e.characters.includes("heron") && e.status === "selected");
  assert.equal(sel.length, 1);
  failMatch = null;
  const r = await add(["--id", "heron", "--replace"]);
  assert.equal(r.character.id, "heron");
  assert.equal(pj().characters.find((c) => c.id === "heron").role, "ครู");
  assert.equal(fs.readdirSync(ref).filter((n) => n.startsWith("old-")).length, 1);
  assert.ok(fs.readdirSync(ref).every((n) => !n.startsWith(".new-")));
});

test("--replace ไม่มี --image: seed ใหม่ (ไม่ได้ภาพเดิมจาก cache)", async () => {
  await add();
  const before = imageCalls().length;
  await add(["--id", "heron", "--replace"]);
  assert.equal(imageCalls().length - before, 3);
  const seeds = libLoad(dir).entries.filter((e) => e.characters.includes("heron") && e.kind === "character-ref").map((e) => e.seed);
  assert.equal(new Set(seeds).size, 6);
});

test("foreground ตอนมี job รันอยู่ใน project → USAGE ไม่ยิง fetch ไม่แตะ state", async () => {
  const jd = path.join(dir, ".jobs", "20260101-000000-aaaa");
  fs.mkdirSync(jd, { recursive: true });
  fs.writeFileSync(path.join(jd, "job.json"), JSON.stringify({ id: "20260101-000000-aaaa", status: "running", started_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(jd, "job.pid"), String(process.pid));
  await assert.rejects(add(), (e) => e.code === "USAGE" && e.message.includes("job กำลังรัน"));
  await assert.rejects(placeAdd(["demo", "--prompt", "สวน", "--foreground"]), (e) => e.code === "USAGE");
  assert.equal(calls.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, ".vf/character-hf-state.json")));
  fs.rmSync(jd, { recursive: true });
  const nJobs = fs.readdirSync(path.join(dir, ".jobs")).length;
  assert.equal((await add()).character.id, "heron");
  const jobs = fs.readdirSync(path.join(dir, ".jobs"));
  assert.equal(jobs.length, nJobs + 1);
  assert.ok(!fs.existsSync(path.join(dir, ".jobs/.lock")));
});

test("addCharacterFiles: id ถูกจองก่อนย้ายไฟล์ → USAGE ไม่เรียก commit · entry เดิมเหมือนกัน → no-op", () => {
  let n = 0;
  const commit = () => { n++; };
  addCharacterFiles(dir, heron(), { commit });
  assert.equal(n, 1);
  addCharacterFiles(dir, heron(), { commit });
  assert.equal(n, 1);
  assert.equal(pj().characters.filter((c) => c.id === "heron").length, 1);
  assert.throws(() => addCharacterFiles(dir, heron({ role: "อื่น" }), { commit }), (e) => e.code === "USAGE");
  assert.throws(() => addCharacterFiles(dir, heron({ id: "kitchen" }), { commit }), (e) => e.code === "USAGE");
  assert.equal(n, 1);
  addCharacterFiles(dir, heron({ role: "อื่น" }), { commit, replace: true });
  assert.equal(n, 2);
});

test("--image เป็นโฟลเดอร์ → USAGE", async () => {
  await assert.rejects(add(["--image", root]), (e) => e.code === "USAGE");
  assert.equal(calls.length, 0);
});

test("commitStagedRefs: crash หลังย้าย extra แต่ก่อน main → รันซ้ำแล้ว main.png เป็นภาพใหม่ และ extra ใหม่ไม่ถูกเก็บเข้า old", () => {
  const d = path.join(dir, "characters/heron/ref");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, ".new-main.png"), "NEW-MAIN");
  fs.writeFileSync(path.join(d, "extra-1.png"), "NEW-EXTRA");
  fs.mkdirSync(path.join(d, "old-X"));
  fs.writeFileSync(path.join(d, "old-X", "main.png"), "OLD-MAIN");
  const lib = libLoad(dir);
  const entry = lib.entries.find((e) => e.kind === "character-ref");
  commitStagedRefs(dir, "heron", { entryId: entry.id, archiveName: "old-X", demoteTo: "replaced" });
  assert.equal(fs.readFileSync(path.join(d, "main.png"), "utf8"), "NEW-MAIN");
  assert.equal(fs.readFileSync(path.join(d, "extra-1.png"), "utf8"), "NEW-EXTRA");
  assert.equal(fs.readFileSync(path.join(d, "old-X", "main.png"), "utf8"), "OLD-MAIN");
  assert.ok(fs.readdirSync(d).every((n) => !n.startsWith(".new-")));
});

// --- final fix (R13) ---
test("R13: character add / place add ที่พังแล้วรันซ้ำ: run เดิม, cost.usd รวมรอบที่พัง, step/item ตามชนิด", async () => {
  const vf = path.join(dir, ".vf");
  let n0 = readCosts(vf).length;
  failMatch = HERON.slice(0, 40);
  await assert.rejects(add(["--id", "heron"]), (e) => e.code === "PROVIDER");
  failMatch = null;
  const r = await add(["--id", "heron"]);
  let rows = readCosts(vf).slice(n0);
  assert.ok(rows.every((x) => x.run === rows[0].run));
  assert.ok(Math.abs(r.cost.usd - rows.reduce((s, x) => s + (x.usd ?? 0), 0)) < 1e-12);
  assert.ok(rows.some((x) => x.step === "character" && x.item === "heron" && x.usd > 0));
  assert.ok(rows.filter((x) => x.step === "ref").every((x) => x.item === "heron"));
  assert.ok(rows.filter((x) => x.step === "qa").every((x) => x.item === "heron"));

  n0 = readCosts(vf).length;
  failMatch = "quiet backyard garden";
  await assert.rejects(placeAdd(["demo", "--prompt", "สวนหลังบ้าน", "--id", "garden", "--foreground"]), (e) => e.code === "PROVIDER");
  failMatch = null;
  const p = await placeAdd(["demo", "--prompt", "สวนหลังบ้าน", "--id", "garden", "--foreground"]);
  rows = readCosts(vf).slice(n0);
  assert.ok(rows.every((x) => x.run === rows[0].run));
  assert.ok(Math.abs(p.cost.usd - rows.reduce((s, x) => s + (x.usd ?? 0), 0)) < 1e-12);
  assert.ok(rows.some((x) => x.step === "place" && x.item === "garden" && x.usd > 0));
  assert.ok(rows.filter((x) => x.step === "plate" || x.step === "qa").every((x) => x.item === "garden"));
});

test("I4: character add บันทึกผล QA ของทุก candidate ลงคลัง", async () => {
  await add();
  const refs = libLoad(dir).entries.filter((e) => e.characters.includes("heron"));
  assert.equal(refs.length, 3);
  for (const e of refs) assert.ok(e.qa && e.qa.pass === true && e.qa.answers.single_character.noul === 0.9);
  assert.deepEqual(refs.map((e) => e.status).sort(), ["candidate", "candidate", "selected"]);
});
