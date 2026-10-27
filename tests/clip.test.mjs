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
import { main as create } from "../tools/project-create.mjs";
import { main as clip, validateClipPlan } from "../tools/clip.mjs";
import { mixArgs, narrationTempo } from "../tools/audio.mjs";
import { goodBible } from "./fixtures/bible.mjs";
import { bodyOf } from "./fixtures/body.mjs";

process.env.VF_NO_DOTENV = "1";
const TINY = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
const B64 = fs.readFileSync(TINY).toString("base64");
const ENV = { CLOUDFLARE_AI_ACCOUNT_ID: "acc1", CLOUDFLARE_AI_API_TOKEN: "tok-secret-123456" };
const ENV_KEYS = [...Object.keys(ENV), "VF_PROJECTS"];
const PLAN = () => ({
  title: "Cake Heist", summary: "แมวแอบกินเค้ก หมาจับได้", duration: 5, characters: ["cat", "dog"], place: "kitchen",
  first_frame_prompt: "The cat reaches for a cake on the kitchen table while the dog peeks from the door.",
  video_prompt: "0-2s: the cat sniffs the cake. 2-5s: the dog barks softly and the cat freezes.",
  narration: "มะลิแอบชิมเค้ก แต่ถุงเท้าเห็นหมด", music_prompt: "Light acoustic guitar, playful, 100 BPM",
});

let MP4, WAV, MP3, root, dir, saved, calls, origWrite, plan, pollFail, needsMusic;
const reply = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });
const videoPosts = () => calls.filter((c) => c.method === "POST" && c.body?.model === MODELS.video);
const imagePosts = () => calls.filter((c) => c.body?.model === MODELS.imageFast);
const ttsPosts = () => calls.filter((c) => c.body?.model === MODELS.tts);
const musicPosts = () => calls.filter((c) => c.body?.model === MODELS.music);
const streams = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", f], { encoding: "utf8" }));

before(() => {
  MP4 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vf-clipfix-")), "tiny.mp4");
  const fx = path.dirname(MP4);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x284:rate=8:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", MP4]);
  WAV = path.join(fx, "n.wav");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-ar", "24000", "-ac", "1", WAV]);
  MP3 = path.join(fx, "m.mp3");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", MP3]);
});

function install() {
  calls = [];
  cf.setFetch(async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    if (u.startsWith("https://cdn.example/m")) return new Response(fs.readFileSync(MP3));
    if (u.startsWith("https://cdn.example/")) return new Response(fs.readFileSync(MP4));
    if (u.includes("/ai/requests/")) {
      calls.push({ url: u, method, body: null });
      if (pollFail) return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, result: { state: "failed", error: "boom" } }) };
      return reply({ state: "completed", result: { video: "https://cdn.example/v.mp4" } });
    }
    const body = bodyOf(url, init);
    calls.push({ url: u, method, body });
    if (u.includes("clef-omni")) {
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { noul: /text/.test(k) || k === "has_people_or_animals" || k === "dialogue_heavy" ? 0 : k === "needs_music" ? needsMusic : 0.9 }]));
      return reply({ answers, usage: { prompt_tokens: 1500 } });
    }
    if (body?.model === MODELS.image || body?.model === MODELS.imageFast) return reply({ image: B64 });
    if (body?.model === MODELS.video) return reply({ state: "queued", request_id: "req-1" });
    if (body?.model === MODELS.tts) return reply({ audio: "data:audio/wav;base64," + fs.readFileSync(WAV).toString("base64") });
    if (body?.model === MODELS.music) return reply({ state: "Completed", result: { audio: "https://cdn.example/m.mp3" } });
    if (body?.model === MODELS.llm[0]) {
      const sys = body.input.systemInstruction.parts[0].text;
      const data = sys.includes("story bible") ? goodBible() : plan;
      return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 300 } });
    }
    throw new Error("unexpected fetch " + u);
  });
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vf-clip-"));
  Object.assign(process.env, ENV, { VF_PROJECTS: root });
  cf.setSleep(async () => {});
  plan = PLAN();
  pollFail = false;
  needsMusic = 0.9;
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

const make = (extra = []) => clip(["demo", "--prompt", "แมวแอบกินเค้ก หมาจับได้", "--foreground", ...extra]);

test("clip: keyframe จาก ref + ฉาก, วิดีโอ draft ส่ง keyframe เป็น base64, ไฟล์และ EPISODES ครบ", async () => {
  const r = await make();
  const id = r.clip.id;
  assert.match(id, /^cake-heist-[0-9a-f]{4}$/);
  for (const f of [`clips/${id}/plan.json`, `clips/${id}/keyframe.jpg`, `clips/${id}/clip.mp4`, `clips/${id}/qa.json`, `renders/${id}.mp4`]) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
  assert.equal(r.clip.file, path.join(dir, "renders", `${id}.mp4`));

  const img = imagePosts()[0].body.input;
  assert.deepEqual(Object.keys(img).filter((k) => k.startsWith("input_image_")), ["input_image_0", "input_image_1", "input_image_2"]);
  assert.match(img.prompt, /Image 1 is มะลิ/);
  assert.match(img.prompt, /Image 3 is the location/);

  assert.equal(videoPosts().length, 1);
  const v = videoPosts()[0].body.input;
  assert.equal(v.mode, "i2v");
  assert.equal(v.draft, true);
  assert.equal(v.resolution, "hd");
  assert.equal(v.duration, 5);
  assert.equal(v.aspect_ratio, "9:16");
  assert.equal(v.generate_audio, true);
  assert.ok(v.prompt.endsWith("No background music."));
  assert.ok(!/^https?:|^data:/.test(v.keyframes) && Buffer.from(v.keyframes, "base64").length > 0);

  const qa = JSON.parse(fs.readFileSync(path.join(dir, "clips", id, "qa.json"), "utf8"));
  assert.equal(qa.keyframe.pass, true);
  assert.equal(qa.video.pass, true);
  assert.ok(fs.readFileSync(path.join(dir, "EPISODES.md"), "utf8").includes(`| clip draft | Cake Heist |`));
  const rows = readCosts(path.join(dir, ".vf")).filter((x) => x.step === "video");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usd, 0.06);
  assert.equal(rows[0].clip, id);
  assert.ok(r.cost.usd > 0.06);
});

test("clip --hd: ไม่ส่ง draft และคิด 0.17", async () => {
  const r = await make(["--hd", "--duration", "6"]);
  const v = videoPosts()[0].body.input;
  assert.ok(!("draft" in v));
  assert.equal(v.duration, 6);
  assert.equal(r.clip.quality, "hd");
  assert.equal(readCosts(path.join(dir, ".vf")).find((x) => x.step === "video").usd, 0.17);
});

test("clip: poll ล้มหลังได้ request id → รันซ้ำตามงานเดิม ไม่ POST วิดีโอใหม่", async () => {
  pollFail = true;
  await assert.rejects(make(), (e) => e.code === "PROVIDER" && e.details.request_id === "req-1");
  assert.equal(videoPosts().length, 1);
  pollFail = false;
  const r = await make();
  assert.equal(videoPosts().length, 1);
  assert.ok(fs.existsSync(r.clip.file));
  assert.equal(imagePosts().length, 1, "keyframe ไม่ถูกสร้างใหม่");
});

test("clip: ทำเสร็จแล้วรันซ้ำ → USAGE", async () => {
  await make();
  await assert.rejects(make(), (e) => e.code === "USAGE" && /เสร็จแล้ว/.test(e.message));
});

test("clip --dry-run ไม่ยิง fetch และมีแถว video", async () => {
  const r = await make(["--dry-run"]);
  assert.equal(calls.length, 0);
  assert.ok(r.planned.some((p) => p.step === "video" && p.model === MODELS.video));
  assert.ok(r.estimated_usd > 0.06);
});

test("clip: --duration ผิด → USAGE", async () => {
  for (const d of ["4", "21", "5.5", "x"]) await assert.rejects(make(["--duration", d]), (e) => e.code === "USAGE");
});

test("validateClipPlan: id ที่ไม่มี, จำนวนตัวละคร, duration, คำเสี่ยง", () => {
  const ctx = { characters: [{ id: "cat" }, { id: "dog" }], places: [{ id: "kitchen" }] };
  assert.deepEqual(validateClipPlan(PLAN(), ctx), []);
  assert.ok(validateClipPlan({ ...PLAN(), characters: ["cow"] }, ctx).some((i) => i.includes("cow")));
  assert.ok(validateClipPlan({ ...PLAN(), characters: [] }, ctx).length);
  assert.ok(validateClipPlan({ ...PLAN(), place: "moon" }, ctx).some((i) => i.includes("moon")));
  assert.deepEqual(validateClipPlan({ ...PLAN(), place: "" }, ctx), []);
  assert.ok(validateClipPlan({ ...PLAN(), duration: 30 }, ctx).length);
  assert.deepEqual(validateClipPlan({ ...PLAN(), duration: 30 }, ctx, { duration: 8 }), []);
  assert.deepEqual(validateClipPlan(null, ctx), ["แผนคลิปต้องเป็น object"]);
});

test("clip: พากย์ (TTS เสียงผู้บรรยาย) + เพลง แล้ว mix เป็น renders ที่มีเสียง ยาวเท่าวิดีโอ", async () => {
  const r = await make();
  assert.equal(ttsPosts().length, 1);
  assert.deepEqual(ttsPosts()[0].body.input, { text: PLAN().narration, voice: "Kore" });
  assert.equal(musicPosts().length, 1);
  const m = musicPosts()[0].body.input;
  assert.equal(m.music_length_ms, 10000);
  assert.equal(m.force_instrumental, true);
  assert.match(m.prompt, /^Light acoustic guitar/);
  assert.equal(r.clip.music, true);
  assert.equal(r.clip.narration, PLAN().narration);
  for (const f of ["narration.wav", "music.mp3", "clip.mp4"]) assert.ok(fs.existsSync(path.join(dir, "clips", r.clip.id, f)), f);
  const info = streams(r.clip.file);
  assert.ok(info.streams.some((x) => x.codec_type === "audio"));
  assert.ok(Math.abs(Number(info.format.duration) - 2) < 0.2, info.format.duration);
  const steps = readCosts(path.join(dir, ".vf")).map((x) => x.step);
  assert.ok(steps.includes("narration") && steps.includes("music"));
});

test("clip --no-narration --no-music: ไม่เรียก TTS/เพลง และ renders = คลิปดิบ", async () => {
  const r = await make(["--no-narration", "--no-music"]);
  assert.equal(ttsPosts().length, 0);
  assert.equal(musicPosts().length, 0);
  assert.equal(r.clip.narration, null);
  assert.ok(fs.readFileSync(r.clip.file).equals(fs.readFileSync(r.clip.raw)));
});

test("clip: music gate needs_music ต่ำ → ไม่สร้างเพลง (ยังพากย์)", async () => {
  needsMusic = 0.1;
  const r = await make();
  assert.equal(musicPosts().length, 0);
  assert.equal(ttsPosts().length, 1);
  assert.equal(r.clip.music, false);
});

test("clip --music กับ --no-music พร้อมกัน → USAGE", async () => {
  await assert.rejects(make(["--music", "--no-music"]), (e) => e.code === "USAGE");
});

test("validateClipPlan: narration ยาวเกินเวลาคลิป", () => {
  const ctx = { characters: [{ id: "cat" }, { id: "dog" }], places: [{ id: "kitchen" }], lang: "en" };
  const long = Array(20).fill("word").join(" ");
  assert.ok(validateClipPlan({ ...PLAN(), narration: long }, ctx).some((i) => i.includes("narration ยาวเกินไป")));
  assert.deepEqual(validateClipPlan({ ...PLAN(), narration: "Short and sweet line here." }, ctx), []);
  assert.ok(validateClipPlan({ ...PLAN(), music_prompt: "" }, ctx).some((i) => i.includes("music_prompt")));
});

test("audio: narrationTempo และ mixArgs", () => {
  assert.equal(narrationTempo(3, 6), 1);
  assert.equal(narrationTempo(7, 6), 1.27);
  assert.equal(narrationTempo(20, 6), 1.3);
  assert.throws(() => mixArgs({ video: "v.mp4", duration: 5, sceneAudio: false, out: "o.mp4" }), /อย่างน้อยหนึ่ง/);
  const a = mixArgs({ video: "v.mp4", duration: 5, sceneAudio: true, narration: "n.wav", tempo: 1.2, music: "m.mp3", musicGain: 0.4, out: "o.mp4" });
  const g = a[a.indexOf("-filter_complex") + 1];
  assert.match(g, /atempo=1.2/);
  assert.match(g, /sidechaincompress/);
  assert.match(g, /amix=inputs=3/);
  assert.ok(a.includes("copy"));
});
