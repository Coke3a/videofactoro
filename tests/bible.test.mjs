import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBible, BIBLE_SCHEMA, bibleSystemPrompt } from "../tools/bible.mjs";
import { goodBible, LOOK } from "./fixtures/bible.mjs";
import { riskFindings } from "../tools/risk.mjs";
import { slugify, stamp, projectsRoot, resolveProject } from "../tools/paths.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("goodBible ผ่าน validateBible", () => {
  assert.deepEqual(validateBible(goodBible()), []);
  assert.equal(BIBLE_SCHEMA.type, "object");
  assert.match(bibleSystemPrompt("th"), /th/);
});

test("validateBible ไม่ผ่าน id ซ้ำ", () => {
  const b = goodBible();
  b.characters[1].id = "cat";
  const issues = validateBible(b);
  assert.ok(issues.some((i) => i.includes("cat") && i.includes("ซ้ำ")), issues.join("|"));
});

test("validateBible ไม่ผ่าน id ผิดรูปและสถานที่ซ้ำตัวละคร", () => {
  const b = goodBible();
  b.characters[0].id = "แมว";
  b.places[0].id = "dog";
  const issues = validateBible(b);
  assert.ok(issues.some((i) => i.includes("แมว")));
  assert.ok(issues.some((i) => i.includes("dog") && i.includes("ซ้ำ")));
});

test("validateBible ไม่ผ่าน look สั้น", () => {
  const b = goodBible();
  b.characters[0].look = "orange cat";
  assert.ok(validateBible(b).some((i) => i.includes("look") && i.includes("120")));
});

test("validateBible ไม่ผ่าน palette ผิดรูป", () => {
  const b = goodBible();
  b.palette = ["red", "#12345", "#FFFFFF"];
  assert.ok(validateBible(b).some((i) => i.includes("palette")));
  b.palette = ["#FFFFFF", "#000000"];
  assert.ok(validateBible(b).some((i) => i.includes("palette")));
});

test("validateBible ไม่ผ่าน tts_voice นอกรายชื่อ", () => {
  const b = goodBible();
  b.characters[0].tts_voice = "Nobody";
  assert.ok(validateBible(b).some((i) => i.includes("tts_voice") && i.includes("Nobody")));
});

test("validateBible ไม่ผ่านเมื่อ look มีคำว่า Garfield และ issue บอกคำนั้น", () => {
  const b = goodBible();
  b.characters[0].look = `${LOOK} Looks just like Garfield.`;
  const issues = validateBible(b);
  assert.ok(issues.some((i) => i === "look ของ cat มีคำเสี่ยง: Garfield"), issues.join("|"));
});

test("validateBible ตรวจ desc ของสถานที่และ name ของตัวละคร", () => {
  const b = goodBible();
  b.places[0].desc += " like the Starbucks";
  b.characters[1].name = "Pikachu";
  const issues = validateBible(b);
  assert.ok(issues.includes("desc ของ kitchen มีคำเสี่ยง: Starbucks"), issues.join("|"));
  assert.ok(issues.includes("name ของ dog มีคำเสี่ยง: Pikachu"), issues.join("|"));
});

test("validateBible ตรวจ title/style/premise ด้วย", () => {
  const b = goodBible();
  b.title = "Pikachu และเพื่อน";
  b.style_prompt += " in the style of Disney";
  b.premise = "เรื่องของ Elon Musk";
  const issues = validateBible(b);
  for (const k of ["title", "style_prompt", "premise"]) assert.ok(issues.some((i) => i.startsWith(k) && i.includes("มีคำเสี่ยง")), k);
});

test("riskFindings ภาษาไทยและอังกฤษ คืน {id, matched}", () => {
  assert.deepEqual(riskFindings("โดราเอมอนกับ Elon Musk"), [
    { id: "ip", matched: "โดราเอมอน" },
    { id: "realPerson", matched: "elon musk" },
  ]);
  assert.deepEqual(riskFindings("an original orange cat"), []);
  assert.deepEqual(riskFindings("no gore, no blood"), []);
});

test("slugify('หมาแมวซน') ไม่ว่าง เป็น ASCII และได้ค่าเดิมทุกครั้ง (R10)", () => {
  const s = slugify("หมาแมวซน");
  assert.match(s, /^project-[0-9a-f]{8}$/);
  assert.equal(slugify("หมาแมวซน"), s);
  assert.notEqual(slugify("แมวหมาซน"), s);
  assert.match(slugify(""), /^project-\d{8}-\d{4}$/);
  assert.match(slugify("   "), /^project-\d{8}-\d{4}$/);
});

test("slugify('Cat & Dog!') === 'cat-dog' และตัดที่ 40", () => {
  assert.equal(slugify("Cat & Dog!"), "cat-dog");
  const long = slugify("a ".repeat(60));
  assert.ok(long.length <= 40 && !long.endsWith("-"));
});

test("stamp รูปแบบ YYYYMMDD-HHMM", () => {
  assert.match(stamp(), /^\d{8}-\d{4}$/);
  assert.equal(stamp(new Date(2026, 9, 27, 9, 5)), "20261027-0905");
});

test("projectsRoot/resolveProject", () => {
  const saved = process.env.VF_PROJECTS;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vf-paths-"));
  try {
    process.env.VF_PROJECTS = root;
    assert.equal(projectsRoot(), root);
    fs.mkdirSync(path.join(root, "p1", ".vf"), { recursive: true });
    fs.mkdirSync(path.join(root, "bare"));
    fs.mkdirSync(path.join(root, "md"));
    fs.writeFileSync(path.join(root, "md", "PROJECT.md"), "x");
    assert.equal(resolveProject("md"), path.join(root, "md"));
    for (const bad of ["", ".", "..", "../p1", "Bad_Name", "bare", path.join(root, "bare")]) {
      assert.throws(() => resolveProject(bad), (e) => e.code === "USAGE", JSON.stringify(bad));
    }
    assert.equal(resolveProject("p1"), path.join(root, "p1"));
    assert.equal(resolveProject(path.join(root, "p1")), path.join(root, "p1"));
    assert.throws(() => resolveProject("nope"), (e) => e.code === "USAGE");
    delete process.env.VF_PROJECTS;
    assert.match(projectsRoot(), /projects$/);
  } finally {
    saved === undefined ? delete process.env.VF_PROJECTS : (process.env.VF_PROJECTS = saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
