import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

process.env.VF_NO_DOTENV = "1";
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

test("ทุกคำสั่งใน COMMANDS มีไฟล์ module จริง และไม่มี branch 'ยังไม่มีคำสั่งนี้' เหลือ", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const src = readFileSync(bin, "utf8");
  const body = src.match(/const COMMANDS = \{([\s\S]*?)\n\};/)[1];
  const mods = [...body.matchAll(/^\s*"?[a-z ]+"?\s*:\s*(null|"([a-z-]+)")/gm)].map((m) => m[2]).filter(Boolean);
  assert.ok(mods.length >= 9);
  for (const m of mods) assert.ok(existsSync(new URL(`../tools/${m}.mjs`, import.meta.url)), `ไม่มี tools/${m}.mjs`);
  assert.doesNotMatch(src, /ยังไม่มีคำสั่งนี้/);
});
