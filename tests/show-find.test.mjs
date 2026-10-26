import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { main as show } from "../tools/project-show.mjs";
import { main as find } from "../tools/asset-find.mjs";

process.env.VF_NO_DOTENV = "1";
const VF = fileURLToPath(new URL("../bin/vf.mjs", import.meta.url));
let root, dir, saved;

const w = (rel, text = "x") => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const row = (i) => `| 2026-10-0${i} | clip | ตอน ${i} | เรื่อง ${i} | cat | out/${i}.mp4 |`;

beforeEach(() => {
  saved = process.env.VF_PROJECTS;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vf-show-"));
  process.env.VF_PROJECTS = root;
  dir = path.join(root, "demo");
  fs.mkdirSync(path.join(dir, ".vf"), { recursive: true });
  w("PROJECT.md", "# Demo");
  w("project.json", JSON.stringify({
    slug: "demo", title: "แมวผจญภัย", logline: "แมวกับห้องครัว", lang: "th", aspect: "9:16", narrator: true,
    characters: [{ id: "cat", name: "แมว", role: "พระเอก" }, { id: "dog", name: "หมา", role: "คู่หู" }],
    places: [{ id: "kitchen", name: "ครัว" }],
  }));
  w("characters/cat/ref/main.png");
  w("characters/cat/poses/b.png");
  w("characters/cat/poses/a.png");
  w("places/kitchen/plates/main.jpg");
  w("library/blobs/a.png");
  w("library/blobs/b.png");
  w("library/blobs/c.png");
  w(".vf/costs.jsonl", JSON.stringify({ step: "s", model: "m", usd: 0.25, count: 1 }) + "\n");
  w("library/index.json", JSON.stringify({ entries: [
    { id: "e1", kind: "pose", blob: "library/blobs/a.png", tags: ["cat", "jump"], characters: ["cat"], status: "selected", need: "cat jump" },
    { id: "e2", kind: "pose", blob: "library/blobs/b.png", tags: ["cat", "jump"], characters: ["cat"], status: "replaced", need: "x" },
    { id: "e3", kind: "plate", blob: "library/blobs/gone.png", tags: ["cat", "jump"], characters: ["cat"], status: "selected" },
    { id: "e4", kind: "pose", blob: "library/blobs/c.png", tags: ["dog", "jump"], characters: ["dog"], status: "selected" },
  ] }));
});
afterEach(() => {
  if (saved === undefined) delete process.env.VF_PROJECTS;
  else process.env.VF_PROJECTS = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

test("show อ่าน project จาก fixture ได้ครบ", async () => {
  w("EPISODES.md", ["# ตอนที่ทำแล้ว", "", "| วันที่ | โหมด | ชื่อ | เรื่องย่อ | ตัวละคร | ไฟล์ |", "|---|---|---|---|---|---|", ...[1, 2, 3, 4, 5, 6, 7].map(row), ""].join("\n"));
  const r = await show(["demo"]);
  assert.equal(r.project, "demo");
  assert.equal(r.dir, dir);
  assert.equal(r.title, "แมวผจญภัย");
  assert.equal(r.lang, "th");
  assert.equal(r.aspect, "9:16");
  assert.equal(r.narrator, true);
  assert.deepEqual(r.characters[0], {
    id: "cat", name: "แมว", role: "พระเอก",
    ref: path.join(dir, "characters/cat/ref/main.png"),
    poses: [path.join(dir, "characters/cat/poses/a.png"), path.join(dir, "characters/cat/poses/b.png")],
  });
  assert.equal(r.characters[1].ref, null);
  assert.deepEqual(r.characters[1].poses, []);
  assert.deepEqual(r.places, [{ id: "kitchen", name: "ครัว", plates: [path.join(dir, "places/kitchen/plates/main.jpg")] }]);
  assert.equal(r.episodes, 7);
  assert.equal(r.last_episodes.length, 5);
  assert.equal(r.last_episodes[4]["ชื่อ"], "ตอน 7");
  assert.equal(r.last_episodes[0]["ชื่อ"], "ตอน 3");
  assert.equal(r.cost_total_usd, 0.25);
  assert.deepEqual(r.files, { project_md: path.join(dir, "PROJECT.md"), episodes_md: path.join(dir, "EPISODES.md") });
});

test("show: ไม่มี EPISODES.md → 0 ตอน และไม่เขียนอะไร", async () => {
  const r = await show(["demo"]);
  assert.equal(r.episodes, 0);
  assert.deepEqual(r.last_episodes, []);
  assert.equal(fs.existsSync(path.join(dir, "EPISODES.md")), false);
});

test("asset find แมว กระโดด คืน path ที่มีอยู่จริง", async () => {
  const r = await find(["demo", "แมว", "กระโดด"]);
  assert.deepEqual(r.results.map((x) => x.id), ["e1", "e2", "e4"]);
  for (const x of r.results) {
    assert.ok(path.isAbsolute(x.file));
    assert.ok(fs.existsSync(x.file));
  }
  assert.equal(r.results[1].status, "replaced");
  assert.ok(r.results[0].score >= r.results[1].score);
  assert.deepEqual(Object.keys(r.results[0]).sort(), ["file", "id", "kind", "need", "score", "status", "tags"]);
});

test("asset find: --kind --character --limit และ USAGE", async () => {
  assert.deepEqual((await find(["demo", "jump", "--character", "dog"])).results.map((x) => x.id), ["e4"]);
  assert.deepEqual((await find(["demo", "jump", "--kind", "plate"])).results, []);
  assert.equal((await find(["demo", "jump", "--limit", "1"])).results.length, 1);
  for (const bad of [["demo"], ["demo", "jump", "--limit", "0"], ["demo", "jump", "--limit", "x"], ["demo", "jump", "--limit", "1.5"]]) {
    await assert.rejects(() => find(bad), (e) => e.code === "USAGE");
  }
});

test("bin/vf.mjs project show พิมพ์ JSON", () => {
  const p = spawnSync(process.execPath, [VF, "project", "show", dir], {
    encoding: "utf8", env: { ...process.env, VF_NO_DOTENV: "1", VF_PROJECTS: root },
  });
  assert.equal(p.status, 0, p.stderr);
  const j = JSON.parse(p.stdout);
  assert.equal(j.project, "demo");
  assert.equal(j.characters.length, 2);
  assert.equal(j.cost_total_usd, 0.25);
});

test("fix1: blob นอก project / absolute path ถูกข้าม", async () => {
  fs.writeFileSync(path.join(root, "outside.png"), "x");
  const idx = JSON.parse(fs.readFileSync(path.join(dir, "library/index.json"), "utf8"));
  idx.entries.push(
    { id: "o1", kind: "pose", blob: "../outside.png", tags: ["jump", "jump2"], status: "selected" },
    { id: "o2", kind: "pose", blob: path.join(root, "outside.png"), tags: ["jump"], status: "selected" },
    { id: "o3", kind: "pose", blob: "", tags: ["jump"], status: "selected" },
    { id: "o4", kind: "pose", tags: ["jump"], status: "selected" },
  );
  w("library/index.json", JSON.stringify(idx));
  const ids = (await find(["demo", "jump"])).results.map((x) => x.id);
  assert.deepEqual(ids.sort(), ["e1", "e2", "e4"]);
});

test("fix2: ไม่มี entries array → ผลว่าง", async () => {
  w("library/index.json", JSON.stringify({ entries: "bad" }));
  assert.deepEqual((await find(["demo", "jump"])).results, []);
  w("library/index.json", JSON.stringify({}));
  assert.deepEqual((await find(["demo", "jump"])).results, []);
});

test("fix3: entry ที่ไม่มีไฟล์อันดับหนึ่งไม่กินโควตา --limit", async () => {
  const idx = JSON.parse(fs.readFileSync(path.join(dir, "library/index.json"), "utf8"));
  idx.entries.push({ id: "top", kind: "pose", blob: "library/blobs/none.png", tags: ["jump", "jump"], need: "jump", status: "selected", tag_p: { jump: 1 } });
  w("library/index.json", JSON.stringify(idx));
  const r = await find(["demo", "jump", "--limit", "1"]);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].id, "e1");
});

test("fix4: ตาราง EPISODES — escaped pipe, CRLF, หยุดที่บล็อกแรก", async () => {
  w("EPISODES.md", ["# t", "", "| ชื่อ | โน้ต |", "|---|---|", "| a | x \\| y |", "| b | z |", "", "ย่อหน้า", "", "| ชื่อ | โน้ต |", "|---|---|", "| c | w |", ""].join("\r\n"));
  const r = await show(["demo"]);
  assert.equal(r.episodes, 2);
  assert.deepEqual(r.last_episodes[0], { "ชื่อ": "a", "โน้ต": "x | y" });
});

test("fix5: id ที่ผิดรูปไม่ถูกใช้สร้าง path · project.json ไม่มี characters/places", async () => {
  const pj = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  pj.characters.push({ id: "../..", name: "bad", role: "r" });
  pj.places.push({ id: "../x", name: "bad" });
  w("project.json", JSON.stringify(pj));
  const r = await show(["demo"]);
  assert.deepEqual(r.characters.map((c) => c.id), ["cat", "dog"]);
  assert.deepEqual(r.places.map((c) => c.id), ["kitchen"]);
  w("project.json", JSON.stringify({ slug: "demo" }));
  const e = await show(["demo"]);
  assert.deepEqual([e.characters, e.places], [[], []]);
});
