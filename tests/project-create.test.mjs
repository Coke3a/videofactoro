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
import { readCosts } from "../tools/cost.mjs";
import { waitJob } from "../tools/jobs.mjs";
import { main, useUserImage } from "../tools/project-create.mjs";
import { goodBible } from "./fixtures/bible.mjs";

process.env.VF_NO_DOTENV = "1";
const TINY = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
const B64 = fs.readFileSync(TINY).toString("base64");
const ENV_KEYS = ["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "VF_PROJECTS"];

let root, saved, calls, origWrite, failMatch, bible;
const reply = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });
const imageCalls = (m) => calls.filter((c) => c.body?.model === MODELS.image && (!m || c.body.input.prompt.includes(m)));
const CAT = () => bible.characters[0].look;
const DOG = () => bible.characters[1].look;

function install() {
  calls = [];
  cf.setFetch(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).includes("clef-omni")) {
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((k) => [k, { noul: k === "has_text" || k === "has_people_or_animals" ? 0 : 0.9 }]),
      );
      return reply({ answers, usage: { prompt_tokens: 1500 } });
    }
    if (body?.model === MODELS.image) {
      if (failMatch && body.input.prompt.includes(failMatch())) throw new Error("เครือข่ายล่ม");
      return reply({ image: B64 });
    }
    if (body?.model === MODELS.llm[0]) {
      return reply({
        candidates: [{ content: { parts: [{ text: JSON.stringify(bible) }] } }],
        usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 1200 },
      });
    }
    throw new Error("unexpected fetch");
  });
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vf-create-"));
  Object.assign(process.env, { CLOUDFLARE_AI_ACCOUNT_ID: "acc1", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456", VF_PROJECTS: root });
  cf.setSleep(async () => {});
  bible = goodBible();
  failMatch = null;
  install();
  origWrite = process.stderr.write;
  process.stderr.write = () => true;
});
afterEach(() => {
  process.stderr.write = origWrite;
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  cf.setFetch((...a) => globalThis.fetch(...a));
  fs.rmSync(root, { recursive: true, force: true });
});

const create = (extra = []) => main(["--prompt", "แมวกับหมาในครัว", "--name", "demo", "--foreground", ...extra]);

test("สร้างไฟล์ครบตาม spec §5", async () => {
  const r = await create();
  const dir = path.join(root, "demo");
  assert.equal(r.project, "demo");
  assert.equal(r.dir, dir);
  for (const f of [
    "PROJECT.md", "project.json", "EPISODES.md", "characters/cat/ref/main.png", "characters/cat/CHARACTER.md",
    "characters/cat/character.json", "characters/dog/ref/main.png", "places/kitchen/plates/main.jpg",
    "places/kitchen/PLACE.md", "places/kitchen/place.json", "library/index.json", ".vf/create-state.json",
  ]) assert.ok(fs.existsSync(path.join(dir, f)), f);

  const lib = libLoad(dir);
  const refs = lib.entries.filter((e) => e.kind === "character-ref" && e.characters.includes("cat"));
  assert.equal(refs.length, 3);
  assert.equal(refs.filter((e) => e.status === "selected").length, 1);
  assert.equal(new Set(refs.map((e) => e.seed)).size, 3);
  assert.equal(lib.entries.filter((e) => e.kind === "character-ref").length, 6);
  assert.equal(lib.entries.filter((e) => e.kind === "place-plate").length, 1);

  const pj = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  assert.equal(pj.slug, "demo");
  assert.equal(pj.aspect, "9:16");
  assert.equal(pj.version, 1);
  assert.ok(pj.created_at);
  assert.equal(pj.title, bible.title);
  const cj = JSON.parse(fs.readFileSync(path.join(dir, "characters/cat/character.json"), "utf8"));
  assert.equal(cj.ref, "ref/main.png");
  assert.equal(cj.look, bible.characters[0].look);
  const md = fs.readFileSync(path.join(dir, "PROJECT.md"), "utf8");
  for (const h of ["## เรื่องย่อ", "## โลก", "## สไตล์ภาพ", "## เสียงและอารมณ์", "## ตัวละคร", "## สถานที่", "## กฎของเรื่อง", "## แผนที่ไฟล์", "## ต้นทุนสะสม"]) {
    assert.ok(md.includes(h), h);
  }
  assert.ok(md.includes("<!-- vf:auto:characters -->") && md.includes("<!-- vf:auto:cost -->"));
  assert.ok(md.includes(bible.style_prompt));
  assert.match(fs.readFileSync(path.join(dir, "EPISODES.md"), "utf8"), /^# .*\n[\s\S]*\|/);
  assert.equal(execFileSync("file", ["-b", path.join(dir, "places/kitchen/plates/main.jpg")]).toString().slice(0, 4), "JPEG");

  assert.deepEqual(r.characters.map((c) => c.id), ["cat", "dog"]);
  assert.equal(r.characters[0].ref, "characters/cat/ref/main.png");
  assert.equal(r.places[0].plate, "places/kitchen/plates/main.jpg");
  assert.ok(r.cost.usd > 0);
  assert.deepEqual(r.next, ["vf project show demo", "vf character add demo --prompt ...", "vf place add demo --prompt ..."]);
  assert.ok(readCosts(path.join(dir, ".vf")).some((x) => x.step === "bible"));
  assert.ok(!JSON.stringify(r).includes("tok-secret"));
});

test("รันซ้ำหลังพังที่ตัวละครที่สองไม่สร้างตัวแรกใหม่", async () => {
  failMatch = DOG;
  await assert.rejects(create(), (e) => e.code === "PROVIDER");
  const catBefore = imageCalls(CAT()).length;
  const llmBefore = calls.filter((c) => c.body?.model === MODELS.llm[0]).length;
  assert.equal(catBefore, 3);
  assert.equal(llmBefore, 1);
  failMatch = null;
  const r = await create();
  assert.equal(imageCalls(CAT()).length, catBefore);
  assert.equal(calls.filter((c) => c.body?.model === MODELS.llm[0]).length, llmBefore);
  assert.equal(r.characters.length, 2);
  assert.equal(libLoad(path.join(root, "demo")).entries.filter((e) => e.characters.includes("cat")).length, 3);
});

test("project ที่สร้างเสร็จแล้ว: รันซ้ำ → USAGE", async () => {
  await create();
  const n = calls.length;
  await assert.rejects(create(), (e) => e.code === "USAGE" && e.message.includes("มี project นี้แล้ว"));
  assert.equal(calls.length, n);
});

test("ไม่มี --foreground คืน job ทันที", async () => {
  delete process.env.CLOUDFLARE_AI_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_AI_API_TOKEN;
  const r = await main(["--prompt", "cat and dog", "--name", "bg"]);
  try {
    assert.ok(r.job.id);
    assert.equal(r.job.status, "running");
    assert.equal(r.project, "bg");
    assert.ok(fs.existsSync(path.join(root, "bg", ".vf")));
    assert.equal(calls.length, 0);
  } finally {
    await waitJob(r.job.dir, 30, 100);
  }
});

test("--dry-run ไม่ยิง fetch เลย ไม่เขียนไฟล์ และคืน estimated_usd > 0", async () => {
  const r = await main(["--prompt", "cat and dog", "--dry-run"]);
  assert.equal(calls.length, 0);
  assert.equal(r.dry_run, true);
  assert.ok(r.estimated_usd > 0);
  assert.ok(r.planned.some((p) => p.step === "bible" && p.model === MODELS.llm[0] && p.count === 1));
  assert.equal(r.planned.find((p) => p.step === "character-ref").count, 9);
  assert.ok(r.assumptions.length >= 4);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("prompt ไทยล้วนไม่ระบุ --name: slug เป็น project-<stamp>", async () => {
  const r = await main(["--prompt", "หมาแมวซน", "--foreground"]);
  assert.match(r.project, /^project-\d{8}-\d{4}$/);
  assert.ok(fs.existsSync(path.join(root, r.project, "PROJECT.md")));
});

test("--image: ตัวที่ชื่อตรงข้ามการสร้าง ใช้ภาพผู้ใช้ ส่วนที่ไม่ตรงได้ warning", async () => {
  const jpg = path.join(root, "user.jpg");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", TINY, jpg]);
  const r = await create(["--image", `CAT=${jpg}`, "--image", `ghost=${TINY}`]);
  const sys = JSON.stringify(calls.find((c) => c.body?.model === MODELS.llm[0]).body);
  assert.ok(sys.includes("CAT") && sys.includes("ghost"));
  assert.equal(imageCalls(CAT()).length, 0);
  assert.equal(imageCalls(DOG()).length, 3);
  assert.equal(r.characters[0].ref, "characters/cat/ref/main.png");
  assert.ok(r.warnings.some((w) => w.includes("ghost")));
  const png = fs.readFileSync(path.join(root, "demo/characters/cat/ref/main.png"));
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  const e = libLoad(path.join(root, "demo")).entries.find((x) => x.characters.includes("cat"));
  assert.equal(e.kind, "character-ref");
  assert.equal(e.status, "selected");
  assert.equal(e.need, "user image");
});

test("useUserImage คัดลอก PNG ตรงๆ และเรียกซ้ำไม่เพิ่ม entry", async () => {
  const dir = path.join(root, "p");
  fs.mkdirSync(dir);
  const a = await useUserImage(dir, "fox", TINY);
  assert.equal(a.ref, "characters/fox/ref/main.png");
  assert.deepEqual(fs.readFileSync(path.join(dir, a.ref)), fs.readFileSync(TINY));
  await useUserImage(dir, "fox", TINY);
  assert.equal(libLoad(dir).entries.length, 1);
});

test("--image รูปแบบผิด / ไฟล์ไม่มี → USAGE", async () => {
  await assert.rejects(create(["--image", "nopath"]), (e) => e.code === "USAGE");
  await assert.rejects(create(["--image", "cat=/no/such/file.png"]), (e) => e.code === "USAGE");
  await assert.rejects(main(["--foreground"]), (e) => e.code === "USAGE");
});
