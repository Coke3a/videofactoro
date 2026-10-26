import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const bin = new URL("../bin/vf.mjs", import.meta.url).pathname;
const vf = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });

test("vf help exit 0 และมี commands", () => {
  const r = vf("help");
  assert.equal(r.status, 0);
  assert.ok(Array.isArray(JSON.parse(r.stdout).commands));
  assert.ok(r.stdout.includes('"commands"'));
});

test("vf nope exit 2 พร้อมรายชื่อคำสั่ง", () => {
  const r = vf("nope");
  assert.equal(r.status, 2);
  const j = JSON.parse(r.stdout);
  assert.equal(j.error.code, "USAGE");
  assert.ok(j.error.details.commands.includes("setup"));
});

test("คำสั่งที่ยังไม่มีโมดูล → USAGE", () => {
  const r = vf("wait");
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).error.message, /ยังไม่มีคำสั่งนี้: wait/);
});
