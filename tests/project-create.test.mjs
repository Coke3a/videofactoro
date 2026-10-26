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
import { main as waitMain } from "../tools/wait.mjs";
import { main as statusMain } from "../tools/status.mjs";
import { main, useUserImage, buildCommand } from "../tools/project-create.mjs";
import { goodBible } from "./fixtures/bible.mjs";

process.env.VF_NO_DOTENV = "1";
const TINY = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
const B64 = fs.readFileSync(TINY).toString("base64");
const ENV_KEYS = ["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "VF_PROJECTS"];

let root, saved, calls, origWrite, failMatch, bible, fitsSeq;
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
        Object.keys(body.questions).map((k) => [k, { noul: k === "has_text" || k === "has_people_or_animals" ? 0 : k === "fits" && fitsSeq.length ? fitsSeq.shift() : 0.9 }]),
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
  fitsSeq = [];
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
  const clefBefore = calls.filter((c) => c.url.includes("clef-omni")).length;
  assert.equal(clefBefore, 3);
  failMatch = null;
  const r = await create();
  const clefAfter = calls.filter((c) => c.url.includes("clef-omni")).length;
  assert.equal(clefAfter - clefBefore, 3 + 1);
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
    assert.deepEqual(r.next, [`vf wait bg ${r.job.id}`]);
    assert.equal(r.job.status, "running");
    assert.equal(r.project, "bg");
    assert.ok(fs.existsSync(path.join(root, "bg", ".vf")));
    assert.equal(calls.length, 0);
  } finally {
    const done = await waitJob(r.job.dir, 30, 100);
    assert.equal(done.status, "failed");
    assert.equal(done.error.code, "CONFIG");
    const viaSlug = await waitMain(["bg", r.job.id, "--timeout", "0"]);
    assert.equal(viaSlug.status, "failed");
    assert.equal((await statusMain(["bg"])).jobs[0].id, r.job.id);
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
  assert.match(r.project, /^project-[0-9a-f]{8}$/);
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

test("error จาก worker มี details.project และ details.resume", async () => {
  failMatch = DOG;
  await assert.rejects(create(), (e) => {
    assert.equal(e.details.project, "demo");
    assert.match(e.details.resume, /^vf project create /);
    assert.ok(e.details.resume.includes("--name demo"));
    assert.ok(e.details.resume.includes("--prompt"));
    return true;
  });
});

test("buildCommand ใส่ --prompt= และ --image= ใน argv เดียว (prompt ขึ้นต้นด้วย -)", async () => {
  const cmd = buildCommand({ prompt: "--weird -x", slug: "s", lang: "en", aspect: "9:16", maxRerolls: 2, images: [{ name: "-cat", path: "/a b/c.png" }] });
  assert.ok(cmd.includes("--prompt=--weird -x"));
  assert.ok(cmd.includes("--image=-cat=/a b/c.png"));
  assert.ok(cmd.includes("--name=s") || (cmd.includes("--name") && cmd.includes("s")));
  const r = await main(["--prompt=-ขึ้นต้นด้วยขีด", "--name", "dash", "--foreground"]);
  assert.equal(r.project, "dash");
});

test("resume ด้วย prompt/lang/aspect/images ที่ต่างไป → USAGE ระบุฟิลด์", async () => {
  failMatch = DOG;
  await assert.rejects(create(), (e) => e.code === "PROVIDER");
  failMatch = null;
  const n = calls.length;
  const again = (args) => main(["--name", "demo", "--foreground", ...args]);
  await assert.rejects(again(["--prompt", "อย่างอื่น"]), (e) => e.code === "USAGE" && e.message.includes("prompt") && e.message.includes("--name"));
  await assert.rejects(again(["--prompt", "แมวกับหมาในครัว", "--lang", "th"]), (e) => e.code === "USAGE" && e.message.includes("lang"));
  await assert.rejects(again(["--prompt", "แมวกับหมาในครัว", "--aspect", "16:9"]), (e) => e.code === "USAGE" && e.message.includes("aspect"));
  await assert.rejects(again(["--prompt", "แมวกับหมาในครัว", "--image", `x=${TINY}`]), (e) => e.code === "USAGE" && e.message.includes("images"));
  assert.equal(calls.length, n);
  assert.equal((await again(["--prompt", "แมวกับหมาในครัว"])).characters.length, 2);
});

test("--image ซ้ำตัวเดียวกัน: ใช้ภาพแรก และมี warning", async () => {
  const other = path.join(root, "other.png");
  fs.copyFileSync(TINY, other);
  const r = await create(["--image", `cat=${TINY}`, "--image", `CAT=${other}`]);
  assert.ok(r.warnings.some((w) => w.includes("CAT")));
  const e = libLoad(path.join(root, "demo")).entries.filter((x) => x.need === "user image");
  assert.equal(e.length, 1);
});

// --- final fix (R13) ---
const KINDS = new Set(["bible", "ref", "plate", "qa", "look"]);
test("R13: แถว cost มี step ตามชนิด + item + run เดียวกันข้าม resume; cost.usd = ผลรวมของ run นั้น (รวมรอบที่พัง)", async () => {
  failMatch = DOG;
  await assert.rejects(create(), (e) => e.code === "PROVIDER");
  const vf = path.join(root, "demo", ".vf");
  const crashed = readCosts(vf);
  fs.appendFileSync(path.join(vf, "costs.jsonl"), JSON.stringify({ step: "bible", model: "x/y", run: "other", usd: 5, outcome: "ok" }) + "\n");
  failMatch = null;
  const r = await create();
  const rows = readCosts(vf).filter((x) => x.run !== "other");
  const run = rows[0].run;
  assert.ok(typeof run === "string" && run.length > 0);
  assert.ok(rows.every((x) => x.run === run));
  assert.ok(crashed.length > 0 && crashed.every((x) => x.run === run));
  const sum = rows.reduce((s, x) => s + (x.usd ?? 0), 0);
  assert.ok(Math.abs(r.cost.usd - sum) < 1e-12, `${r.cost.usd} vs ${sum}`);
  for (const x of rows) {
    assert.ok(KINDS.has(x.step), x.step);
    assert.ok(["ok", "invalid", "qa_reject", "blocked", "error"].includes(x.outcome), x.outcome);
  }
  assert.ok(rows.filter((x) => x.step === "bible").every((x) => x.item === null));
  assert.deepEqual([...new Set(rows.filter((x) => x.step === "ref").map((x) => x.item))].sort(), ["cat", "dog"]);
  assert.deepEqual([...new Set(rows.filter((x) => x.step === "plate").map((x) => x.item))], ["kitchen"]);
  assert.deepEqual([...new Set(rows.filter((x) => x.step === "qa").map((x) => x.item))].sort(), ["cat", "dog", "kitchen"]);
  const md = fs.readFileSync(path.join(root, "demo", "PROJECT.md"), "utf8");
  assert.equal(md.split("\n").filter((l) => l.startsWith(`| ref | ${MODELS.image} |`)).length, 1);
  assert.ok(!/\| ref:/.test(md));
});

// --- final fix (I4) ---
test("I4: บันทึกผล QA ของทุก candidate ลงคลัง; ตัวที่แพ้ยังเป็น candidate", async () => {
  await create();
  const lib = libLoad(path.join(root, "demo")).entries;
  const refs = lib.filter((e) => e.kind === "character-ref" && e.characters.includes("cat"));
  assert.equal(refs.length, 3);
  for (const e of refs) {
    assert.equal(e.qa.pass, true);
    assert.equal(typeof e.qa.score, "number");
    assert.deepEqual(e.qa.reasons, []);
    assert.equal(e.qa.answers.matches_look.noul, 0.9);
  }
  assert.deepEqual(refs.map((e) => e.status).sort(), ["candidate", "candidate", "selected"]);
  const plate = lib.find((e) => e.kind === "place-plate");
  assert.equal(plate.qa.pass, true);
  assert.equal(plate.qa.answers.fits.noul, 0.9);
});

test("I4: ภาพฉากที่ QA ไม่ผ่าน → แถว qa_reject, summarize นับ reroll, usd ไม่นับซ้ำ, verdict ลงคลัง", async () => {
  fitsSeq = [0.1];
  const r = await create();
  const vf = path.join(root, "demo", ".vf");
  const rows = readCosts(vf).filter((x) => x.step === "plate");
  const s = summarize(rows).rows.find((x) => x.step === "plate");
  assert.equal(s.calls, 2);
  assert.equal(s.rerolls, 1);
  assert.equal(s.ok, 1);
  assert.ok(Math.abs(s.usd - rows.filter((x) => x.outcome !== "qa_reject").reduce((a, x) => a + x.usd, 0)) < 1e-12);
  assert.ok(Math.abs(s.usd - 2 * rows.find((x) => x.outcome === "ok").usd) < 1e-12);
  assert.equal(r.places[0].warning, undefined);
  const plates = libLoad(path.join(root, "demo")).entries.filter((e) => e.kind === "place-plate");
  assert.equal(plates.length, 2);
  const bad = plates.find((e) => e.qa.pass === false);
  assert.equal(bad.status, "candidate");
  assert.ok(bad.qa.reasons.length > 0);
  assert.equal(bad.qa.answers.fits.noul, 0.1);
  assert.equal(plates.find((e) => e.qa.pass).status, "selected");
  assert.ok(fs.readFileSync(path.join(root, "demo", "PROJECT.md"), "utf8").includes("2 (reroll 1)"));
});
