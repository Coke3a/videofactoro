import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cf from "../tools/cf.mjs";
import { VfError } from "../tools/out.mjs";
import { stageFor, spotX, DEFAULT_STAGE } from "../tools/stage.mjs";
import { bodyOf } from "./fixtures/body.mjs";

process.env.VF_NO_DOTENV = "1";
const TINY = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
const ENV = { CLOUDFLARE_AI_ACCOUNT_ID: "acc1", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456" };

let dir, saved, calls, scores, fail, placeFile;
const reply = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });
const place = () => ({ id: "kitchen", name: "ครัว", extra: "keep" });

beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-stage-"));
  fs.mkdirSync(path.join(dir, "places/kitchen/plates"), { recursive: true });
  fs.copyFileSync(TINY, path.join(dir, "places/kitchen/plates/p.png"));
  placeFile = path.join(dir, "places/kitchen/place.json");
  fs.writeFileSync(placeFile, JSON.stringify({ ...place(), plate: "plates/p.png" }));
  scores = { clear_center: 0.1 };
  fail = null;
  calls = [];
  cf.setSleep(async () => {});
  cf.setFetch(async (url, init = {}) => {
    const body = bodyOf(url, init);
    calls.push(body);
    if (fail) throw fail;
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { noul: scores[k] ?? 0.9 }]));
    return reply({ answers, usage: { prompt_tokens: 100 } });
  });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  cf.setFetch((...a) => globalThis.fetch(...a));
  fs.rmSync(dir, { recursive: true, force: true });
});

const args = () => ({ dir, place: place(), meta: {}, costDir: path.join(dir, ".vf") });

test("stageFor ตัด spot ที่ติดเฟอร์นิเจอร์ เขียน place.json และครั้งที่สองไม่เรียก clef", async () => {
  const s = await stageFor(args());
  assert.equal(s.floor, 0.87);
  assert.ok(!("center" in s.spots));
  assert.equal(s.spots.left, 0.25);
  assert.equal(calls.length, 1);
  const q = calls[0].questions;
  assert.match(q.clear_center.instructions, /around 50% from the left/);
  const saved1 = JSON.parse(fs.readFileSync(placeFile, "utf8"));
  assert.deepEqual(saved1.stage, s);
  assert.equal(saved1.extra, "keep");
  assert.equal(saved1.plate, "plates/p.png");
  assert.deepEqual(await stageFor(args()), s);
  assert.equal(calls.length, 1);
});

test("stageFor เหลือน้อยกว่า 2 → เก็บสองอันดับดีสุด", async () => {
  scores = { clear_left: 0.1, clear_center: 0.4, clear_right: 0.3, "clear_far-left": 0.2, "clear_far-right": "x" };
  const s = await stageFor(args());
  assert.deepEqual(Object.keys(s.spots).sort(), ["center", "right"]);
});

test("stageFor clef PROVIDER → DEFAULT_STAGE ไม่เขียนไฟล์", async () => {
  fail = new VfError("PROVIDER", "ล่ม");
  const before = fs.readFileSync(placeFile, "utf8");
  assert.deepEqual(await stageFor(args()), DEFAULT_STAGE);
  assert.equal(fs.readFileSync(placeFile, "utf8"), before);
});

test("spotX อ่านค่า และชื่อไม่รู้จัก → INTERNAL", () => {
  assert.equal(spotX(DEFAULT_STAGE, "far-right"), 0.88);
  assert.throws(() => spotX(DEFAULT_STAGE, "nope"), (e) => e.code === "INTERNAL");
});
