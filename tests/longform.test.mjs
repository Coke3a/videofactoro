import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as cf from "../tools/cf.mjs";
import { MODELS } from "../tools/models.mjs";
import { readCosts } from "../tools/cost.mjs";
import { VfError } from "../tools/out.mjs";
import { main as create } from "../tools/project-create.mjs";
import { main as film, validateFilmPlan } from "../tools/film.mjs";
import { main as motion, validateMotionPlan, motionEvents } from "../tools/motion.mjs";
import { assScript, hasFilter, narrationTrackArgs, stillMotionArgs, frameSize } from "../tools/assemble.mjs";
import { pool } from "../tools/shots.mjs";
import { goodBible } from "./fixtures/bible.mjs";
import { bodyOf } from "./fixtures/body.mjs";

process.env.VF_NO_DOTENV = "1";
const TINY = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
const B64 = fs.readFileSync(TINY).toString("base64");
const ENV = { CLOUDFLARE_AI_ACCOUNT_ID: "acc1", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456" };
const ENV_KEYS = [...Object.keys(ENV), "VF_PROJECTS"];

const shot = (duration, extra = {}) => ({
  duration, characters: ["cat"], place: "kitchen",
  first_frame_prompt: "The cat sits by the cake.", video_prompt: "0-3s: the cat sniffs. 3-6s: the cat jumps.",
  narration: "มะลิเห็นเค้ก", ...extra,
});
const FILM = () => ({
  title: "Cake Day", summary: "แมวกับเค้ก", music_prompt: "Playful pizzicato, 110 BPM",
  shots: [shot(7), shot(7, { characters: ["cat", "dog"] }), shot(6, { narration: "" })],
});
const scene = (duration, extra = {}) => ({
  duration, characters: ["dog"], place: "", image_prompt: "The dog jumps in surprise.", move: "shake",
  card: "", caption: "ถุงเท้าตกใจ", sfx_word: "BONK!", narration: "ถุงเท้าตกใจ", ...extra,
});
const MOTION = () => ({
  title: "Top 4 Oops", summary: "สี่เรื่องพลาด", music_prompt: "Bouncy ukulele, 120 BPM",
  scenes: [scene(5, { card: "#4", move: "zoom_in" }), scene(5, { card: "#3" }), scene(5, { card: "#2", move: "bounce" }), scene(5, { card: "#1", narration: "" })],
});

let MP4, WAV, MP3, root, dir, saved, calls, origWrite, plan, pollFail, flagImages;
const reply = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });
const posts = (model) => calls.filter((c) => c.method === "POST" && c.body?.model === model);
const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", f], { encoding: "utf8" }));

before(() => {
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "vf-longfix-"));
  MP4 = path.join(fx, "tiny.mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x284:rate=8:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", MP4]);
  WAV = path.join(fx, "n.wav");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-ar", "24000", "-ac", "1", WAV]);
  MP3 = path.join(fx, "m.mp3");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", MP3]);
});

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vf-long-"));
  Object.assign(process.env, ENV, { VF_PROJECTS: root });
  cf.setSleep(async () => {});
  pollFail = false;
  flagImages = 0;
  calls = [];
  cf.setFetch(async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    if (u.startsWith("https://cdn.example/m")) return new Response(fs.readFileSync(MP3));
    if (u.startsWith("https://cdn.example/")) return new Response(fs.readFileSync(MP4));
    if (u.includes("/ai/requests/")) {
      calls.push({ url: u, method, body: null });
      if (pollFail) return reply({ state: "failed", error: "boom" });
      return reply({ state: "completed", result: { video: "https://cdn.example/v.mp4" } });
    }
    const body = bodyOf(url, init);
    calls.push({ url: u, method, body });
    if (u.includes("clef-omni")) {
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { noul: /text/.test(k) || k === "has_people_or_animals" ? 0 : 0.9 }]));
      return reply({ answers, usage: { prompt_tokens: 1500 } });
    }
    if (body?.model === MODELS.image) {
      if (flagImages > 0) {
        flagImages--;
        const err = JSON.stringify({ errors: [{ message: "AiError: AiError: Your output has been flagged. Please choose another prompt / input image combination (x)", code: 3030 }], success: false });
        return { ok: false, status: 400, text: async () => err };
      }
      return reply({ image: B64 });
    }
    if (body?.model === MODELS.video) return reply({ state: "queued", request_id: `req-${posts(MODELS.video).length}` });
    if (body?.model === MODELS.tts) return reply({ audio: "data:audio/wav;base64," + fs.readFileSync(WAV).toString("base64") });
    if (body?.model === MODELS.music) return reply({ state: "Completed", result: { audio: "https://cdn.example/m.mp3" } });
    if (body?.model === MODELS.llm[0]) {
      const sys = body.input.systemInstruction.parts[0].text;
      const data = sys.includes("story bible") ? goodBible() : plan;
      return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 300 } });
    }
    throw new Error("unexpected fetch " + u);
  });
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

const CTX = { characters: [{ id: "cat" }, { id: "dog" }], places: [{ id: "kitchen" }], lang: "th" };

test("film: ช็อตละ keyframe + วิดีโอ draft, ต่อกัน, รางพากย์ + เพลงเดียว, EPISODES", async () => {
  plan = FILM();
  const r = await film(["demo", "--prompt", "วันเกิดมะลิ", "--duration", "20", "--foreground"]);
  const id = r.film.id;
  assert.match(id, /^cake-day-[0-9a-f]{4}$/);
  assert.equal(r.film.shots, 3);
  assert.equal(posts(MODELS.image).length, 3);
  assert.equal(posts(MODELS.video).length, 3);
  for (const p of posts(MODELS.video)) {
    assert.equal(p.body.input.draft, true);
    assert.ok(p.body.input.prompt.endsWith("No background music."));
  }
  assert.equal(posts(MODELS.tts).length, 2, "ช็อตที่ narration ว่างไม่เรียก TTS");
  assert.equal(posts(MODELS.music).length, 1);
  for (const f of ["plan.json", "shot-01.jpg", "shot-03.mp4", "norm-02.mp4", "film-raw.mp4", "narration.wav", "music.mp3"]) {
    assert.ok(fs.existsSync(path.join(dir, "films", id, f)), f);
  }
  const out = probe(r.film.file);
  assert.deepEqual(out.streams.map((s) => s.codec_type).sort(), ["audio", "video"]);
  assert.ok(Math.abs(Number(out.format.duration) - 6) < 0.6, `ต่อ 3 ช็อต × 2 วินาที (${out.format.duration})`);
  assert.equal(r.film.narration, true);
  assert.equal(r.film.music, true);
  assert.ok(fs.readFileSync(path.join(dir, "EPISODES.md"), "utf8").includes("| film draft | Cake Day |"));
  const videoRows = readCosts(path.join(dir, ".vf")).filter((x) => x.step === "video");
  assert.equal(videoRows.length, 3);
  assert.ok(r.cost.usd >= 0.18);
});

test("film: วิดีโอค้างแล้วรันซ้ำ ตาม request เดิม ไม่ POST ใหม่", async () => {
  plan = FILM();
  pollFail = true;
  await assert.rejects(film(["demo", "--prompt", "วันเกิดมะลิ", "--duration", "20", "--foreground"]));
  assert.equal(posts(MODELS.video).length, 3);
  pollFail = false;
  const r = await film(["demo", "--prompt", "วันเกิดมะลิ", "--duration", "20", "--foreground"]);
  assert.equal(posts(MODELS.video).length, 3, "ไม่จ่ายวิดีโอซ้ำ");
  assert.ok(fs.existsSync(r.film.file));
  await assert.rejects(film(["demo", "--prompt", "วันเกิดมะลิ", "--duration", "20", "--foreground"]), (e) => e.code === "USAGE");
});

test("film: ภาพที่ถูก flag (3030) เปลี่ยน seed แล้วลองใหม่ ไม่ล้มทั้งเรื่อง; flag ทุกครั้ง = BLOCKED", async () => {
  plan = FILM();
  plan.shots = [shot(10), shot(10)];
  flagImages = 2;
  const r = await film(["demo", "--prompt", "ภาพโดน flag", "--duration", "20", "--foreground"]);
  assert.ok(fs.existsSync(r.film.file));
  const seeds = posts(MODELS.image).map((p) => p.body.input.seed);
  assert.equal(seeds.length, 4);
  assert.equal(new Set(seeds).size, 4, "ทุกครั้งที่ลองใหม่ใช้ seed ใหม่");
  flagImages = 99;
  await assert.rejects(film(["demo", "--prompt", "ภาพโดน flag ตลอด", "--duration", "20", "--foreground"]), (e) => e.code === "BLOCKED");
});

test("film --dry-run และ --duration นอกช่วง ไม่เรียก API", async () => {
  const d = await film(["demo", "--prompt", "x", "--duration", "90", "--dry-run"]);
  assert.equal(d.dry_run, true);
  assert.equal(d.planned.find((p) => p.step === "video").count, 13);
  assert.ok(d.estimated_usd > 0.7);
  await assert.rejects(film(["demo", "--prompt", "x", "--duration", "10"]), (e) => e instanceof VfError && e.code === "USAGE");
  assert.equal(calls.length, 0);
});

test("validateFilmPlan: ผลรวมผิด, ช็อตสั้นไป, ตัวละครไม่มีจริง, พากย์ยาวเกิน", () => {
  assert.deepEqual(validateFilmPlan(FILM(), CTX, { total: 20 }), []);
  const bad = FILM();
  bad.shots[0].duration = 3;
  bad.shots[1].characters = ["ghost"];
  bad.shots[2].narration = "ก".repeat(80);
  const issues = validateFilmPlan(bad, CTX, { total: 20 }).join("\n");
  assert.match(issues, /shots\[0\]\.duration/);
  assert.match(issues, /ghost/);
  assert.match(issues, /shots\[2\]\.narration ยาวเกินไป/);
  assert.match(validateFilmPlan(FILM(), CTX, { total: 40 }).join("\n"), /ผลรวม duration = 20/);
});

test("motion: ภาพนิ่งต่อฉาก ไม่ใช้โมเดลวิดีโอ, ต่อฉาก + พากย์ + เพลง, ยาวตามแผน", async () => {
  plan = MOTION();
  const r = await motion(["demo", "--prompt", "4 เรื่องพลาดของถุงเท้า", "--duration", "20", "--foreground"]);
  const id = r.motion.id;
  assert.match(id, /^top-4-oops-[0-9a-f]{4}$/);
  assert.equal(posts(MODELS.video).length, 0);
  assert.equal(posts(MODELS.image).length, 4);
  assert.equal(posts(MODELS.tts).length, 3);
  assert.equal(posts(MODELS.music).length, 1);
  const out = probe(r.motion.file);
  assert.deepEqual(out.streams.map((s) => s.codec_type).sort(), ["audio", "video"]);
  assert.ok(Math.abs(Number(out.format.duration) - 20) < 0.5, String(out.format.duration));
  assert.equal(r.motion.text, hasFilter("ass"));
  if (!hasFilter("ass")) assert.match(r.motion.warnings.join(" "), /libass/);
  assert.ok(fs.readFileSync(path.join(dir, "EPISODES.md"), "utf8").includes("| motion | Top 4 Oops |"));
  const imgs = readCosts(path.join(dir, ".vf")).filter((x) => x.step === "still");
  assert.equal(imgs.length, 4);
});

test("validateMotionPlan: move ผิด, card ยาว, จำนวนฉากผิด", () => {
  assert.deepEqual(validateMotionPlan(MOTION(), CTX, { total: 20 }), []);
  const bad = MOTION();
  bad.scenes[0].move = "spin";
  bad.scenes[1].card = "THIS IS WAY TOO LONG";
  const issues = validateMotionPlan(bad, CTX, { total: 20 }).join("\n");
  assert.match(issues, /scenes\[0\]\.move/);
  assert.match(issues, /scenes\[1\]\.card ยาวเกิน/);
  const few = MOTION();
  few.scenes = [scene(8)];
  assert.match(validateMotionPlan(few, CTX, { total: 20 }).join("\n"), /scenes ต้องมี 3–6 ช่วง/);
});

test("motionEvents + assScript: ชื่อเรื่อง การ์ด คำบรรยาย คำเสียง ตามเวลา, ตัด { } ออก", () => {
  const ev = motionEvents("Top {4}", [
    { seconds: 5, card: "#4", caption: "แรก", sfx_word: "BONK!" },
    { seconds: 4, card: "", caption: "สอง", sfx_word: "" },
  ]);
  assert.deepEqual(ev.map((e) => e.style), ["Title", "Card", "Caption", "Sfx", "Caption"]);
  assert.equal(ev[3].start, 2);
  assert.equal(ev[4].start, 5.2);
  const ass = assScript({ ...frameSize("9:16"), font: "DejaVu Sans", events: ev });
  assert.match(ass, /PlayResX: 720\nPlayResY: 1280/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:02\.50,Title,,0,0,0,,\{\\fad\(200,200\)\}Top 4/);
  assert.match(ass, /0:00:05\.20,0:00:08\.90,Caption/);
});

test("narrationTrackArgs / stillMotionArgs: หน่วงตามเวลา, เร่ง tempo, จำนวนเฟรมตรง", () => {
  const a = narrationTrackArgs({ items: [{ file: "a.wav", at: 0 }, { file: "b.wav", at: 7.5, tempo: 1.2 }], duration: 20, out: "o.wav" });
  const g = a[a.indexOf("-filter_complex") + 1];
  assert.match(g, /\[1:a\][^;]*atempo=1\.2,adelay=7500\|7500/);
  assert.match(g, /amix=inputs=2:normalize=0[^;]*atrim=0:20\.000/);
  const s = stillMotionArgs({ image: "i.jpg", out: "o.mp4", w: 720, h: 1280, seconds: 5, move: "pan_left" });
  assert.equal(s[s.indexOf("-frames:v") + 1], "120");
  assert.match(s[s.indexOf("-vf") + 1], /zoompan=z='1\.15'.*s=720x1280:fps=24/);
});

test("pool: จำกัดงานพร้อมกัน คืนผลตามลำดับ และโยน error แรก", async () => {
  let live = 0;
  let peak = 0;
  const out = await pool([1, 2, 3, 4, 5], 2, async (x) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return x * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
  await assert.rejects(pool([1, 2], 2, async (x) => { if (x === 2) throw new Error("no"); return x; }), /no/);
});
