import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAMERAS, ENTERS, MOVES, FX, LEAD, GAP, TAIL, SCENE_MIN,
  STORY_SCHEMA, scenesSchema, storySystemPrompt, scenesSystemPrompt, validateScenePlan, estimateSeconds,
} from "../tools/motion-plan.mjs";
import { geminiStrip, anthropicStrip } from "../tools/llm.mjs";

process.env.VF_NO_DOTENV = "1";

const SPOTS = ["left", "center", "right", "far-left", "far-right"];
const ASSETS = {
  poses: { biscuit: ["idle", "curious", "scared", "run", "happy"], marmalade: ["idle", "curious", "happy"] },
  places: { living: SPOTS, hallway: ["far-left", "far-right", "center"], kitchen: SPOTS },
  props: ["vacuum"],
  sfx: ["whirr", "pop", "whoosh", "boing", "bang", "ding"],
};

// แผน spike 3 แปลง x → spot
const plan = () => ({
  scenes: [
    { id: "s01", place: "living", camera: "push",
      cast: [{ who: "biscuit", spot: "center", size: 0.62, pose: "idle", enter: "drop" }],
      props: [],
      lines: [{ who: "narrator", text: "This is Biscuit. Biscuit is a very brave puppy." }, { who: "narrator", text: "Mostly." }],
      beats: [{ at: "line2", who: "biscuit", pose: "curious" }] },
    { id: "s02", place: "living", camera: "pan-left",
      cast: [{ who: "biscuit", spot: "left", size: 0.5, pose: "curious" }],
      props: [{ id: "vacuum", spot: "right", size: 0.32, enter: "slide-right" }],
      lines: [{ who: "narrator", text: "Today, a strange round thing arrived in the living room." }, { who: "biscuit", text: "Hello? Are you a new friend?" }],
      beats: [] },
    { id: "s03", place: "living", camera: "push-fast",
      cast: [{ who: "biscuit", spot: "left", size: 0.5, pose: "curious" }],
      props: [{ id: "vacuum", spot: "right", size: 0.32 }],
      lines: [{ who: "narrator", text: "The new friend did not say hello." }],
      beats: [{ at: 1.6, fx: "stamp", text: "VRRRM!" }, { at: "1.6", fx: "shake" }, { at: 1.6, sfx: "whirr" },
        { at: 1.6, who: "vacuum", move: "to", to_spot: "center", dur: 1.2 },
        { at: 1.7, who: "biscuit", pose: "scared", move: "jump" }] },
    { id: "s04", place: "hallway", camera: "static",
      cast: [{ who: "biscuit", spot: "far-left", size: 0.42, pose: "run" }],
      props: [],
      lines: [{ who: "narrator", text: "So Biscuit ran. Very, very fast." }],
      beats: [{ at: 0.2, who: "biscuit", move: "run-to", to_spot: "far-right", dur: 2.4 }] },
    { id: "s05", place: "kitchen", camera: "push",
      cast: [{ who: "marmalade", spot: "right", size: 0.5, pose: "idle" }],
      props: [],
      lines: [{ who: "narrator", text: "In the kitchen, Marmalade was enjoying a quiet afternoon." }, { who: "marmalade", text: "Ahh. Peace and quiet." }],
      beats: [] },
    { id: "s06", place: "kitchen", camera: "static",
      cast: [{ who: "marmalade", spot: "right", size: 0.5, pose: "idle" }, { who: "biscuit", spot: "left", size: 0.5, pose: "scared", enter: "slide-left" }],
      props: [],
      lines: [{ who: "biscuit", text: "Marmalade! A monster is coming! It goes vrrrm!" }],
      beats: [{ at: 0.6, who: "marmalade", pose: "curious" }, { at: 0.5, who: "biscuit", move: "shiver", dur: 3 }] },
    { id: "s07", place: "kitchen", camera: "pan-right",
      cast: [{ who: "marmalade", spot: "right", size: 0.5, pose: "curious" }, { who: "biscuit", spot: "left", size: 0.5, pose: "scared" }],
      props: [{ id: "vacuum", spot: "far-right", size: 0.3 }],
      lines: [{ who: "marmalade", text: "That? Oh, please. That is just a vacuum." }],
      beats: [{ at: 0.2, who: "vacuum", move: "to", to_spot: "center", dur: 1.6 }, { at: 0.2, sfx: "whirr" }] },
    { id: "s08", place: "kitchen", camera: "push",
      cast: [{ who: "biscuit", spot: "left", size: 0.5, pose: "scared" }, { who: "marmalade", spot: "center", size: 0.42, pose: "happy", ride: "vacuum" }],
      props: [{ id: "vacuum", spot: "center", size: 0.3 }],
      lines: [{ who: "narrator", text: "And Marmalade hopped on for a ride." }],
      beats: [{ at: 0, who: "marmalade", move: "hop" }, { at: 0.4, sfx: "pop" }, { at: 0.8, who: "vacuum", move: "to", to_spot: "far-right", dur: 2.4 }] },
    { id: "s09", place: "kitchen", camera: "push-fast",
      cast: [{ who: "biscuit", spot: "center", size: 0.58, pose: "curious" }],
      props: [],
      lines: [{ who: "biscuit", text: "Wait... can I ride too?" }],
      beats: [{ at: "line1-end", who: "biscuit", pose: "happy", move: "hop" }] },
    { id: "s10", place: "living", camera: "pan-left",
      cast: [{ who: "biscuit", spot: "left", size: 0.4, pose: "happy", ride: "vacuum" }, { who: "marmalade", spot: "right", size: 0.4, pose: "happy" }],
      props: [{ id: "vacuum", spot: "left", size: 0.3 }],
      lines: [{ who: "narrator", text: "And that is how Biscuit made a brand new friend." }, { who: "biscuit", text: "Wheee!" }],
      beats: [{ at: 0.3, who: "vacuum", move: "loop", dur: 5 }, { at: "line2", fx: "stamp", text: "THE END" }] },
  ],
});

const OPTS = (p, extra = {}) => ({ total: Math.round(estimateSeconds(p, "en")), lang: "en", narrator: true, ...extra });

test("enums and timing constants", () => {
  assert.deepEqual(CAMERAS, ["push", "push-fast", "pan-left", "pan-right", "static"]);
  assert.deepEqual(ENTERS, ["drop", "slide-left", "slide-right"]);
  assert.deepEqual(MOVES, ["hop", "jump", "shiver", "run-to", "to", "loop"]);
  assert.deepEqual(FX, ["stamp", "shake"]);
  assert.deepEqual([LEAD, GAP, TAIL, SCENE_MIN], [0.45, 0.3, 0.7, 3]);
});

test("valid spike plan has no issues", () => {
  const p = plan();
  assert.deepEqual(validateScenePlan(p, ASSETS, OPTS(p)), []);
});

test("unknown pose for that character is named", () => {
  const p = plan();
  p.scenes[0].cast[0].pose = "dance";
  const issues = validateScenePlan(p, ASSETS, OPTS(p));
  assert.ok(issues.some((s) => s.includes("dance")), issues.join("\n"));
  // ท่าที่มีของตัวอื่นแต่ไม่มีของตัวนี้ก็ต้องโดน
  const q = plan();
  q.scenes[4].beats.push({ at: 0.5, who: "marmalade", pose: "scared" });
  assert.ok(validateScenePlan(q, ASSETS, OPTS(q)).some((s) => s.includes("scared") && s.includes("marmalade")));
});

test("unknown to_spot is an issue", () => {
  const p = plan();
  p.scenes[3].beats[0].to_spot = "offstage";
  assert.ok(validateScenePlan(p, ASSETS, OPTS(p)).some((s) => s.includes("offstage")));
  // spot ที่มีในฉากอื่นแต่ไม่มีใน hallway
  const q = plan();
  q.scenes[3].beats[0].to_spot = "left";
  assert.ok(validateScenePlan(q, ASSETS, OPTS(q)).some((s) => s.includes("left") && s.includes("hallway")));
});

test("line reference past the scene's lines is an issue", () => {
  const p = plan();
  p.scenes[0].beats[0].at = "line3";
  assert.ok(validateScenePlan(p, ASSETS, OPTS(p)).some((s) => s.includes("line3")));
  const q = plan();
  q.scenes[0].beats[0].at = "line2-end";
  assert.deepEqual(validateScenePlan(q, ASSETS, OPTS(q)), []);
  q.scenes[0].beats[0].at = "soon";
  assert.ok(validateScenePlan(q, ASSETS, OPTS(q)).some((s) => s.includes("soon")));
});

test("total far from target names both numbers", () => {
  const p = plan();
  p.scenes = p.scenes.slice(0, 5);
  const est = estimateSeconds(p, "en");
  assert.ok(est > 25 && est < 35, String(est));
  const issues = validateScenePlan(p, ASSETS, { total: 60, lang: "en", narrator: true });
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.equal(issues[0], `estimated ${est.toFixed(1)}s, target 60s (±15%): add lines or scenes`);
});

test("estimateSeconds follows lead + lines + gaps + tail with a floor", () => {
  const one = { scenes: [{ lines: [{ who: "narrator", text: "one two three four five six seven eight nine ten eleven" }] }] };
  assert.equal(Math.round(estimateSeconds(one, "en") * 1000), Math.round((0.45 + 11 / 2.2 + 0.7) * 1000));
  const two = { scenes: [{ lines: [{ text: "a b c d e f g h i j k" }, { text: "a b c d e f g h i j k" }] }, { lines: [] }, { lines: [{ text: "hi" }] }] };
  assert.equal(Math.round(estimateSeconds(two, "en") * 1000), Math.round((0.45 + 10 + 0.3 + 0.7 + 3 + 3) * 1000));
  const th = { scenes: [{ lines: [{ text: "ก".repeat(55) }] }] };
  assert.equal(Math.round(estimateSeconds(th, "th") * 1000), Math.round((0.45 + 5 + 0.7) * 1000));
});

test("Thai lines use the character budget", () => {
  const p = plan();
  for (const s of p.scenes) for (const l of s.lines) l.text = "สวัสดีจ้า";
  p.scenes[1].lines[1].text = "ก".repeat(56);
  const issues = validateScenePlan(p, ASSETS, { total: Math.round(estimateSeconds(p, "th")), lang: "th", narrator: true });
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /s02 line 2/);
  assert.match(issues[0], /56/);
  assert.match(issues[0], /55/);
  // ภาษาอังกฤษนับคำ: 12 คำ > 11
  const q = plan();
  q.scenes[1].lines[1].text = "one two three four five six seven eight nine ten eleven twelve";
  assert.ok(validateScenePlan(q, ASSETS, OPTS(q)).some((s) => /s02 line 2/.test(s) && /12/.test(s) && /11/.test(s)));
});

test("ids, cast count, ride, props, sfx, stamp, narrator, scene count, risk", () => {
  const check = (mut, needle, extra) => {
    const p = plan();
    mut(p);
    const issues = validateScenePlan(p, ASSETS, OPTS(p, extra));
    assert.ok(issues.some((s) => s.includes(needle)), `${needle}: ${issues.join(" / ")}`);
  };
  check((p) => { p.scenes[0].place = "garage"; }, "garage");
  check((p) => { p.scenes[0].camera = "zoom"; }, "zoom");
  check((p) => { p.scenes[0].cast[0].who = "rex"; }, "rex");
  check((p) => { p.scenes[0].cast[0].spot = "roof"; }, "roof");
  check((p) => { p.scenes[0].cast[0].enter = "fly"; }, "fly");
  check((p) => { p.scenes[0].cast = []; }, "1–3");
  check((p) => { p.scenes[5].cast.push({ who: "biscuit", spot: "center", pose: "idle" }); }, "biscuit");
  check((p) => { p.scenes[7].props = []; }, "vacuum");
  check((p) => { p.scenes[1].props[0].id = "lamp"; }, "lamp");
  check((p) => { p.scenes[2].beats[2].sfx = "kazoo"; }, "kazoo");
  check((p) => { p.scenes[2].beats[0].text = "VRRRRRRRRRRRRM"; }, "12");
  check((p) => { p.scenes[2].beats[0].text = ""; }, "stamp");
  check((p) => { p.scenes[2].beats[1].fx = "glow"; }, "glow");
  check((p) => { p.scenes[2].beats[4].move = "spin"; }, "spin");
  check((p) => { p.scenes[3].beats[0].to_spot = undefined; }, "to_spot");
  check((p) => { p.scenes[4].beats.push({ at: 0, who: "biscuit", move: "hop" }); }, "biscuit");
  check((p) => { p.scenes[4].lines[1].who = "biscuit"; }, "biscuit");
  check((p) => { p.scenes[4].lines[1].text = " "; }, "text");
  check(() => {}, "narrator", { narrator: false });
  check((p) => { p.scenes = p.scenes.slice(0, 3); }, "4–14");
  check((p) => { p.scenes[1].lines[1].text = "Hello, I am Mickey Mouse"; }, "risk");
  assert.deepEqual(validateScenePlan(null, ASSETS, { total: 30, lang: "en" }), ["plan must be an object with a scenes array"]);
});

test("schemas use only llmJson-safe features and enums from assets", () => {
  const s = scenesSchema(ASSETS);
  const json = JSON.stringify(s);
  for (const bad of ["oneOf", "anyOf", "const", "\"enum\":[]"]) assert.ok(!json.includes(bad), bad);
  const scene = s.properties.scenes.items.properties;
  assert.deepEqual(scene.place.enum, ["living", "hallway", "kitchen"]);
  assert.deepEqual(scene.camera.enum, CAMERAS);
  const cast = scene.cast.items.properties;
  assert.deepEqual(cast.who.enum, ["biscuit", "marmalade"]);
  assert.deepEqual(cast.pose.enum, ["idle", "curious", "scared", "run", "happy"]);
  assert.deepEqual(cast.spot.enum, SPOTS);
  assert.deepEqual(cast.ride.enum, ["vacuum"]);
  const beat = scene.beats.items.properties;
  assert.equal(beat.at.type, "string");
  assert.deepEqual(beat.who.enum, ["biscuit", "marmalade", "vacuum"]);
  assert.deepEqual(beat.sfx.enum, ASSETS.sfx);
  assert.deepEqual(scene.lines.items.properties.who.enum, ["narrator", "biscuit", "marmalade"]);
  // ไม่มี prop → ไม่มี enum ว่าง
  const bare = JSON.stringify(scenesSchema({ ...ASSETS, props: [] }));
  assert.ok(!bare.includes("\"enum\":[]"));
  geminiStrip(s); anthropicStrip(s); anthropicStrip(STORY_SCHEMA);
  assert.deepEqual(STORY_SCHEMA.required, ["title", "summary", "music_prompt", "beats", "props_needed"]);
  assert.deepEqual(STORY_SCHEMA.properties.beats.items.properties.part.enum, ["setup", "problem", "escalation", "twist", "button"]);
});

test("prompts mention the target, language, assets and narrator rule", () => {
  const ctx = {
    direction: "Gentle slapstick for kids",
    characters: [{ id: "biscuit", name: "Biscuit", personality: "brave-ish puppy", poses: ["idle", "scared"] }],
    places: ["living", "kitchen"],
    props: [{ id: "vacuum", desc: "round robot vacuum" }],
  };
  const sp = storySystemPrompt("th", 45, ctx);
  for (const s of ["45", "th", "biscuit", "brave-ish puppy", "scared", "kitchen", "vacuum", "round robot vacuum", "Gentle slapstick", "button"]) assert.ok(sp.includes(s), s);
  const on = scenesSystemPrompt("en", 60, ASSETS, { narrator: true });
  const off = scenesSystemPrompt("en", 60, ASSETS, { narrator: false });
  for (const s of ["60", "hallway", "far-right", "marmalade", "whirr", "12"]) assert.ok(on.includes(s), s);
  assert.notEqual(on, off);
  assert.match(off, /no narrator/i);
});
