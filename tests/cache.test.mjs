import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic, readJson } from "../tools/state.mjs";
import { cacheKey, libLoad, libAdd, libFindByKey, libUpdate, libSearch } from "../tools/cache.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "vf-cache-"));
const base = { id: "x", kind: "pose", file: "a.png", key: "k", prompt: "p", need: "", model: "m", refs: [], characters: [], place: null, tags: [], tag_p: {}, qa: {}, status: "candidate", used_in: [], cost_usd: 0 };
const ent = (o) => ({ lib: { entries: [{ ...base, ...o }] } });

test("cacheKey เปลี่ยนเมื่อเนื้อไฟล์ ref เปลี่ยน แม้ path เดิม", () => {
  const d = tmp();
  try {
    const f = join(d, "r.png");
    writeFileSync(f, "one");
    const k1 = cacheKey({ model: "m", prompt: "p", refs: [f] });
    assert.equal(k1, cacheKey({ model: "m", prompt: "p", refs: [f] }));
    writeFileSync(f, "two");
    assert.notEqual(k1, cacheKey({ model: "m", prompt: "p", refs: [f] }));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("cacheKey เปลี่ยนเมื่อลำดับ ref เปลี่ยน", () => {
  const d = tmp();
  try {
    const a = join(d, "a.png"), b = join(d, "b.png");
    writeFileSync(a, "A"); writeFileSync(b, "B");
    assert.notEqual(cacheKey({ model: "m", prompt: "p", refs: [a, b] }), cacheKey({ model: "m", prompt: "p", refs: [b, a] }));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("libAdd แล้ว libFindByKey เจอ และไฟล์ blob มีอยู่จริง", () => {
  const d = tmp();
  try {
    assert.deepEqual(libLoad(d), { entries: [] });
    const e = libAdd(d, { ...base, id: "cat-1", key: "abc" }, Buffer.from("png"), "png");
    assert.match(e.blob, /^library\/blobs\/[0-9a-f]{12}\.png$/);
    assert.ok(existsSync(join(d, e.blob)));
    assert.ok(e.created_at);
    assert.equal(libFindByKey(libLoad(d), "abc").id, "cat-1");
    assert.throws(() => libAdd(d, { ...base, id: "cat-1", key: "z" }, Buffer.from("q"), "png"), { code: 2 });
    const u = libUpdate(d, "cat-1", { status: "selected", id: "hack" });
    assert.equal(u.status, "selected");
    assert.equal(u.id, "cat-1");
    assert.equal(libLoad(d).entries[0].status, "selected");
    assert.throws(() => libUpdate(d, "nope", {}), { code: 2 });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("libSearch คำไทย แมว กระโดด เจอ entry ที่ tags มี cat, jump ก่อน entry ที่มีแค่ cat", () => {
  const lib = { entries: [
    { ...base, id: "only", tags: ["cat"] },
    { ...base, id: "both", tags: ["cat", "jump"] },
    { ...base, id: "none", tags: ["dog"] },
  ] };
  const r = libSearch(lib, ["แมว", "กระโดด"], {});
  assert.deepEqual(r.map((x) => x.entry.id), ["both", "only"]);
  assert.equal(r[0].score, 6);
  assert.equal(r[1].score, 3);
});

test("libSearch ลดคะแนน rejected", () => {
  const lib = { entries: [
    { ...base, id: "bad", tags: ["cat"], status: "rejected" },
    { ...base, id: "ok", tags: ["cat"], status: "selected" },
  ] };
  const r = libSearch(lib, ["cat"], {});
  assert.deepEqual(r.map((x) => [x.entry.id, x.score]), [["ok", 3], ["bad", 1]]);
});

test("libSearch tag_p, ส่วนหนึ่งของ tag, need และ filter", () => {
  const { lib } = ent({ tags: ["jump"], tag_p: { jump: 0.5 }, need: "a cat", characters: ["tom"] });
  assert.equal(libSearch(lib, ["jump"], {})[0].score, 4.5);
  assert.equal(libSearch(lib, ["jum"], {})[0].score, 1.5);
  assert.equal(libSearch(lib, ["cat"], {})[0].score, 1);
  assert.equal(libSearch(lib, ["jump"], { character: "tom" }).length, 1);
  assert.equal(libSearch(lib, ["jump"], { character: "x" }).length, 0);
  assert.equal(libSearch(lib, ["zzz"], {}).length, 0);
});

test("writeJsonAtomic ไม่ทิ้งไฟล์ .tmp และสร้างโฟลเดอร์แม่", () => {
  const d = tmp();
  try {
    const f = join(d, "sub", "dir", "a.json");
    writeJsonAtomic(f, { a: 1 });
    assert.deepEqual(readJson(f), { a: 1 });
    assert.equal(readJson(join(d, "none.json"), 7), 7);
    assert.deepEqual(readdirSync(join(d, "sub", "dir")), ["a.json"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("libAdd ปฏิเสธ ext ที่ไม่ปลอดภัย", () => {
  const d = tmp();
  try {
    assert.throws(() => libAdd(d, { ...base, id: "e" }, Buffer.from("x"), "../../esc"), { code: 2 });
    assert.deepEqual(libLoad(d), { entries: [] });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("libSearch: constructor ไม่ throw, [''] ได้ [], tag_p ไม่สนตัวพิมพ์, ไม่มี reverse substring", () => {
  const lib = { entries: [{ ...base, tags: ["Jump", "a"], tag_p: { Jump: 0.5 } }] };
  assert.deepEqual(libSearch(lib, ["constructor"], {}), []);
  assert.deepEqual(libSearch(lib, [""], {}), []);
  assert.deepEqual(libSearch(lib, ["  "], {}), []);
  assert.equal(libSearch(lib, [" jump "], {})[0].score, 4.5);
  assert.deepEqual(libSearch(lib, ["abc"], {}), []);
});
