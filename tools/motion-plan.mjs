import { riskFindings } from "./risk.mjs";
import { narrationBudget, narrationSize, CHARS_PER_SEC } from "./clip.mjs";
import { ID_RE } from "./bible.mjs";
import { forbiddenHits } from "./product.mjs";

export const CAMERAS = ["push", "push-fast", "pan-left", "pan-right", "static"];
export const ENTERS = ["drop", "slide-left", "slide-right"];
export const MOVES = ["hop", "jump", "shiver", "run-to", "to", "loop"];
export const FX = ["stamp", "shake"];
export const PARTS = ["setup", "problem", "escalation", "twist", "button"];
// โหมดสินค้า (project มี product.json): ฉากแทรกรูปสินค้าจริงเต็มจอ + ฉากปิดบอกราคา + ขนาดมุมกล้อง
export const KINDS = ["scene", "insert", "endcard"];
export const SHOTS = ["wide", "medium", "close", "low"];
export const CHIP_MAX = 18;
export const INSERTS_MIN = 2;

// เวลาต่อฉาก (วินาที) ต้องตรงกับ composer: lead + บท + ช่องว่างระหว่างบท + tail ขั้นต่ำ SCENE_MIN
export const LEAD = 0.45;
export const GAP = 0.3;
export const TAIL = 0.7;
export const SCENE_MIN = 3;
export const SCENES_MIN = 4;
export const SCENES_MAX = 14;
export const MAX_CAST = 3;
export const STAMP_MAX = 12;
// ±15% ปล่อยคลิปที่สองเป้า 60 วิให้ออกมา 71.7 วิ
export const TOTAL_TOLERANCE = 0.1;
export const SCENE_MAX = 12;
// คลิปแรกจริงอยู่ห้องเดียวทั้ง 12 ฉากทั้งที่มี 3 สถานที่ → ฉากเยอะพอแล้วต้องย้ายที่
export const MULTI_PLACE_SCENES = 6;
const LINE_SECONDS = 6;
// อัตราพูดจริงของ TTS ใน motion (ภาษาเว้นวรรค, ตัดเงียบแล้ว): คลิปแรก 92 คำ / 32.87 วิ = 2.80,
// คลิปสอง 148 คำ / 56.8 วิ = 2.61 → รวม 240 คำ / 89.67 วิ ≈ 2.68 คำ/วิ
// WORDS_PER_SEC 2.2 ของ clip.mjs ทำให้ประเมินเกิน → คลิปเป้า 60 วิออกมา 50 วิ; คำสั่งอื่นยังใช้ค่าเดิม
export const MOTION_WPS = 2.68;

const str = { type: "string" };
const num = { type: "number" };
// enum ว่างทำ schema พัง → ปล่อยเป็น string แล้วให้ validator จับ
const oneOf = (list) => (list.length ? { type: "string", enum: list } : str);
const uniq = (xs) => [...new Set(xs)];
const arr = (v) => (Array.isArray(v) ? v : []);
const withDefaults = (a) => ({
  poses: a?.poses ?? {}, places: a?.places ?? {}, props: arr(a?.props), sfx: arr(a?.sfx),
  floorProps: arr(a?.floorProps), product: a?.product ?? null,
});
const kindOf = (sc) => (KINDS.includes(sc?.kind) ? sc.kind : "scene");
const spaced = (lang) => narrationBudget(lang, 1).unit === "คำ";
const unitEn = (lang) => (spaced(lang) ? "words" : "characters");
const rate = (lang) => (spaced(lang) ? MOTION_WPS : CHARS_PER_SEC);
// งบต่อบท: ไทยใช้งบตัวอักษรเดิม ภาษาเว้นวรรคนับตามอัตราพูดของ motion
export const lineMax = (lang) => (spaced(lang) ? Math.floor((LINE_SECONDS - 1) * MOTION_WPS) : narrationBudget(lang, LINE_SECONDS).max);

export const STORY_SCHEMA = {
  type: "object",
  properties: {
    title: str,
    summary: str,
    music_prompt: str,
    beats: {
      type: "array",
      items: { type: "object", properties: { part: oneOf(PARTS), text: str }, required: ["part", "text"] },
    },
    props_needed: {
      type: "array",
      items: { type: "object", properties: { id: str, desc: str }, required: ["id", "desc"] },
    },
  },
  required: ["title", "summary", "music_prompt", "beats", "props_needed"],
};

// assets = { poses: {charId: [pose]}, places: {placeId: [spot]}, props: [id], sfx: [kind] }
export function scenesSchema(raw = {}) {
  const assets = withDefaults(raw);
  const chars = Object.keys(assets.poses);
  const spots = uniq(Object.values(assets.places).flat());
  const props = assets.props;
  const cast = { who: oneOf(chars), spot: oneOf(spots), pose: oneOf(uniq(Object.values(assets.poses).flat())), size: num, enter: oneOf(ENTERS) };
  if (props.length) cast.ride = oneOf(props);
  return {
    type: "object",
    properties: {
      scenes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: str,
            ...(assets.product ? {
              kind: oneOf(KINDS), shot: oneOf(SHOTS), focus: oneOf(chars),
              image: oneOf(assets.product.images.map((im) => im.id)), chip: str,
            } : {}),
            place: oneOf(Object.keys(assets.places)),
            camera: oneOf(CAMERAS),
            cast: { type: "array", items: { type: "object", properties: cast, required: ["who", "spot", "pose"] } },
            props: {
              type: "array",
              items: { type: "object", properties: { id: oneOf(props), spot: oneOf(spots), size: num, enter: oneOf(ENTERS) }, required: ["id", "spot"] },
            },
            lines: {
              type: "array",
              items: { type: "object", properties: { who: oneOf(["narrator", ...chars]), text: str }, required: ["who", "text"] },
            },
            beats: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  // ตัวเลข/ข้อความผสมกันใน schema ไม่ได้ → string ทั้งหมด ("1.5", "line2", "line2-end")
                  at: str,
                  who: oneOf(uniq([...chars, ...props])),
                  pose: cast.pose,
                  move: oneOf(MOVES),
                  to_spot: oneOf(spots),
                  dur: num,
                  fx: oneOf(FX),
                  sfx: oneOf(assets.sfx),
                  text: str,
                },
                required: ["at"],
              },
            },
          },
          required: ["id", "place", "camera", "cast", "props", "lines", "beats"],
        },
      },
    },
    required: ["scenes"],
  };
}

// ข้อมูลสินค้าที่ LLM ใช้ได้ (ข้อเท็จจริงและคำอ้างจาก listing เท่านั้น)
const productLines = (pr) => [
  `- The product: ${pr.name}${pr.brand ? ` (brand ${pr.brand})` : ""}${pr.show_price && pr.price_text ? `, price ${pr.price_text}` : ""}.`,
  "- Facts you may state (nothing else about size, material or numbers):",
  ...(pr.facts.length ? pr.facts.map((f) => `  - ${f}`) : ["  (none)"]),
  "- Benefits you may claim (no other claims):",
  ...(pr.claims_allowed.length ? pr.claims_allowed.map((f) => `  - ${f}`) : ["  (none)"]),
  pr.forbidden_words.length ? `- Never say or show: ${pr.forbidden_words.join(", ")}.` : "",
  `- No comparisons with other products, no discounts or free shipping, ${pr.show_price ? "no prices other than the one above" : "never mention the price"}.`,
  "- Soft sell: the story leads and the product is part of it. No pushy selling (no \"buy now\", \"hurry\", \"cheap\", \"must have\"); the character just uses it and it helps.",
];

function productStoryPrompt(lang, total, ctx, chars, props) {
  const pr = ctx.product;
  return [
    `You write the story for a ${total}-second vertical product clip (TikTok/Reels/Shorts) made of cut-out cartoon characters on painted backgrounds, with real product photos shown full screen. Reply with JSON matching the schema only.`,
    ctx.direction ? `- Project direction: ${ctx.direction}` : "",
    ...productLines(pr),
    pr.angles.length ? `- Story angles from the product brief (pick one): ${pr.angles.join(" | ")}` : "",
    "- The clip is content first: a funny, relatable little story (or a useful tip) people would watch even without the product. The product shows up as a natural part of the story, never as an advert.",
    "- beats: exactly 5, in this order. setup: an everyday situation without the product (the hook, first 3 seconds). problem: the trouble grows, funny and relatable; the character may try something that fails. escalation: the product turns up naturally in the story (shown as its real photo). twist: the character uses it and things go right, showing one or two benefits in action rather than listing them. button: a last gag or warm payoff, with the product just visible; at most a light mention, no sales pitch. Each text is 1–2 plain English sentences.",
    "- Use only these characters, and only actions their poses can show:",
    ...(chars.length ? chars : ["  (none)"]),
    `- Places available: ${(ctx.places ?? []).join(", ") || "(none)"}. One place is fine; only change place when the story needs it.`,
    "- Existing props (the product prop is the real product photo):",
    ...(props.length ? props : ["  (none)"]),
    "- props_needed: reuse existing ids; avoid new props (0–1 small ones at most). Never invent a prop that is another version of the product.",
    "- music_prompt (English): one upbeat background track, mood, instruments and BPM, no vocals.",
    `- title and summary in ${lang}.`,
  ].filter(Boolean).join("\n");
}

export function storySystemPrompt(lang, total, ctx = {}) {
  const chars = (ctx.characters ?? []).map((c) => `  - ${c.id} (${c.name ?? c.id}): ${c.personality ?? ""} · poses: ${(c.poses ?? []).join(", ")}`);
  const props = (ctx.props ?? []).map((p) => `  - ${p.id}: ${p.desc ?? ""}${p.placement === "floor" ? " (lies flat on the floor; characters can stand or exercise on it)" : ""}`);
  if (ctx.product) return productStoryPrompt(lang, total, ctx, chars, props);
  return [
    `You write the story for a ${total}-second kids' cartoon gag clip made of cut-out characters on painted backgrounds. Reply with JSON matching the schema only.`,
    ctx.direction ? `- Project direction: ${ctx.direction}` : "",
    "- beats: exactly 5, in this order: setup → problem → escalation → twist → button (the button is one quick final gag). Each text is 1–2 plain English sentences saying what happens and who does it.",
    "- Use only these characters, and only actions their poses can show:",
    ...(chars.length ? chars : ["  (none)"]),
    `- Places available: ${(ctx.places ?? []).join(", ") || "(none)"}. Stay in these places.`,
    (ctx.places ?? []).length >= 2
      ? "- Move the story through 2–3 of these places (e.g. start in one room, chase into another, end somewhere new); say in the beat text where it happens."
      : "",
    "- Existing props:",
    ...(props.length ? props : ["  (none)"]),
    "- props_needed: every prop the story uses. Reuse an existing id when it fits; a new prop gets a new id (a-z, 0-9, -, starts with a letter) and a short English visual description of one object. Keep props few (0–3).",
    "- Simple physical comedy a 5-year-old gets without words. No real people, brands or copyrighted characters, nothing scary or violent.",
    "- music_prompt (English): one playful background track, mood, instruments and BPM, no vocals.",
    `- title and summary in ${lang}.`,
  ].filter(Boolean).join("\n");
}

export function scenesSystemPrompt(lang, total, raw, { narrator = false } = {}) {
  const assets = withDefaults(raw);
  const n = Math.round(total / (assets.product ? 3.5 : 5));
  const max = lineMax(lang);
  const poses = Object.entries(assets.poses).map(([c, ps]) => `  - ${c}: ${ps.join(", ")}`);
  const places = Object.entries(assets.places).map(([p, ss]) => `  - ${p}: ${ss.join(", ")}`);
  const pr = assets.product;
  return [
    `You turn a 5-part gag outline into the scene list of a ${total}-second kids' cartoon. Reply with JSON matching the schema only.`,
    `- scenes: about ${n} (${SCENES_MIN}–${SCENES_MAX}), following the outline in order. Each scene has a short id (s01, s02, ...), one place, one camera move (${CAMERAS.join(", ")}).`,
    `- Timing: a scene lasts ${LEAD}s + its spoken lines (about ${rate(lang)} ${unitEn(lang)}/s) + ${GAP}s between lines + ${TAIL}s, at least ${SCENE_MIN}s. All scenes together must come within ±${TOTAL_TOLERANCE * 100}% of ${total}s.`,
    `- cast: 1–${MAX_CAST} characters per scene. Each stands only on a named spot of that place (spot), wears one of ITS OWN poses, may enter (${ENTERS.join(", ")}) and may ride a prop that is in the scene's props.`,
    "- Poses per character:",
    ...poses,
    "- Spots per place:",
    ...places,
    places.length >= 2 && !pr
      ? `- Use 2–3 different places, following where the outline says things happen: change place at a story turn (a chase leads into another room, the twist or button happens somewhere new). Keep neighbouring scenes in one place while the action stays there. With ${MULTI_PLACE_SCENES}+ scenes, one place for the whole clip is rejected.`
      : "",
    `- props: { id, spot, enter? } from: ${(assets.props ?? []).join(", ") || "(none)"}.`,
    (assets.floorProps ?? []).length
      ? `- Floor props lie flat on the floor (mats, rugs): ${assets.floorProps.join(", ")}. A character standing, sitting or exercising on one sets ride to its id; give the prop the same spot as that character.`
      : "",
    `- lines: short, in ${lang}, at most ${max} ${unitEn(lang)} each. who is ${narrator ? '"narrator" or ' : ""}a character in that scene's cast.`,
    narrator ? "- The narrator tells the story briefly; characters speak their own short lines." : "- There is no narrator in this project: every line is spoken by a character in the cast.",
    `- beats: { at, who?, pose?, move?, to_spot?, dur?, fx?, sfx?, text? }. at is seconds from scene start as a string ("1.5") or "line<N>" / "line<N>-end" (N counts from 1 within the scene). who is a cast id or a prop id in the scene. move: ${MOVES.join(", ")} (to and run-to need to_spot). fx: stamp (needs text) or shake. sfx: ${(assets.sfx ?? []).join(", ")}.`,
    `- No on-screen text except stamps: a sound word or 1–2 words, at most ${STAMP_MAX} characters (e.g. BONK!, THE END).`,
    "- Make it move: most scenes need at least one beat. Every beat must change something: a pose, a move, an fx or an sfx (a beat with only text, who or dur is dropped). End on the button gag.",
    pr
      ? `- Every kind "scene" needs 1–${MAX_CAST} cast characters, each standing on a named spot. insert and endcard scenes have empty cast, props and beats.`
      : `- Every scene needs 1–${MAX_CAST} cast characters, each standing on a named spot; never leave cast empty.`,
    ...(pr ? productScenesLines(pr, assets) : ["- No real people, brands or copyrighted characters."]),
  ].filter(Boolean).join("\n");
}

function productScenesLines(pr, assets) {
  const imgs = pr.images.map((im) => `  - ${im.id} (${im.role}): ${im.shows || im.role}${im.feature ? ` · feature: ${im.feature}` : ""}`);
  return [
    "- This is a product clip. Scene kinds (field kind):",
    `  - scene (default): characters in a place, as above. shot: wide (whole room), medium (closer on the cast), close (one character's face, set focus), low (floor level close on one character's feet and what they stand on, set focus). Vary the shot: never 3 scenes in a row with the same shot; use close for reactions (pain, surprise, joy) and low for the product in use on the floor.`,
    "  - insert: the real product photo full screen with a slow zoom. Set image to one of the images below and chip to a 1–4 word label of what it shows (at most " + CHIP_MAX + " characters, in the clip language, only from the facts/benefits). The narrator says one short line about it. Use the hero image when the product first appears.",
    `  - endcard: the last scene only, exactly one: the hero photo and product name${pr.show_price && pr.price_text ? " and price" : ""}${pr.cta ? `, with the note "${pr.cta}"` : ""}. The narrator says at most one short, casual line (e.g. what the character uses now); no pushy call to buy${pr.show_price ? "" : ", no price"}.`,
    "- Product images:",
    ...imgs,
    `- At least ${INSERTS_MIN} insert scenes, showing different images; put a scene with a character using the product between inserts. Most of the clip is the story with characters, not inserts.`,
    (assets.floorProps ?? []).length ? "- After the product appears, show the character using the real product prop in at least one scene." : "",
    "- Keep scenes short (3–4 s): about one line each. Hook in the first scene.",
    ...productLines(pr).slice(1),
    "- No real people and no other brands.",
  ];
}

const lineSeconds = (lang, text) => narrationSize(lang, String(text ?? "")) / rate(lang);

export const sceneSeconds = (scene, lang) => {
  const lines = arr(scene?.lines);
  if (!lines.length) return SCENE_MIN;
  const talk = lines.reduce((s, l) => s + lineSeconds(lang, typeof l?.text === "string" ? l.text : ""), 0);
  return Math.max(SCENE_MIN, LEAD + talk + GAP * (lines.length - 1) + TAIL);
};

export const estimateSeconds = (plan, lang) => arr(plan?.scenes).reduce((s, sc) => s + sceneSeconds(sc, lang), 0);

// at: ตัวเลข, ตัวเลขเป็นข้อความ หรือ line<N>[-end] (N นับจาก 1 ในฉาก)
function atIssue(at, nLines) {
  if (typeof at === "number") return Number.isFinite(at) && at >= 0 ? null : `at ${at} must be ≥ 0 seconds`;
  const s = String(at ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return null;
  const m = /^line(\d+)(-end)?$/.exec(s);
  if (!m) return `at "${s}" must be seconds ("1.5") or "line<N>" / "line<N>-end"`;
  const k = Number(m[1]);
  return k >= 1 && k <= nLines ? null : `at "${s}" refers to a line this scene does not have (it has ${nLines})`;
}

export function validateStory(story) {
  if (story === null || typeof story !== "object" || Array.isArray(story)) return ["story must be an object"];
  const issues = [];
  const risky = (label, text) => {
    for (const f of riskFindings(String(text ?? ""))) issues.push(`${label} has a risk word: ${f.matched}`);
  };
  for (const k of ["title", "summary", "music_prompt"]) {
    if (typeof story[k] !== "string" || !story[k].trim()) issues.push(`${k} must be non-empty text`);
  }
  risky("title", story.title);
  risky("summary", story.summary);
  const beats = arr(story.beats);
  if (beats.length !== PARTS.length) issues.push(`beats must be exactly ${PARTS.length} (${PARTS.join(", ")}), got ${beats.length}`);
  beats.forEach((b, i) => {
    const label = `beat ${i + 1}`;
    if (i < PARTS.length && b?.part !== PARTS[i]) issues.push(`${label}: part must be "${PARTS[i]}" (got "${b?.part}"); order is ${PARTS.join(" → ")}`);
    if (typeof b?.text !== "string" || !b.text.trim()) issues.push(`${label}: text must not be empty`);
    risky(`${label} text`, b?.text);
  });
  if (!Array.isArray(story.props_needed)) issues.push("props_needed must be an array (may be empty)");
  const seen = new Set();
  arr(story.props_needed).forEach((p, i) => {
    const label = `props_needed ${i + 1}`;
    const id = p?.id;
    if (typeof id !== "string" || !ID_RE.test(id)) issues.push(`${label}: id "${id}" must be a-z, 0-9, - (starts with a letter, 2–31 chars)`);
    else if (seen.has(id)) issues.push(`${label}: id "${id}" appears twice`);
    seen.add(id);
    if (typeof p?.desc !== "string" || !p.desc.trim()) issues.push(`${label}: desc must not be empty`);
    risky(`${label} desc`, p?.desc);
  });
  return issues;
}

// beat ที่ไม่ทำอะไรเลย (ไม่มี pose/move/fx/sfx) ไม่มีผลต่อภาพ → ตัดทิ้งก่อน validate แก้ plan ในที่เดิม
export function normalizeScenePlan(plan) {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.scenes)) return plan;
  for (const sc of plan.scenes) {
    if (sc && Array.isArray(sc.beats)) sc.beats = sc.beats.filter((b) => b && (b.pose || b.move || b.fx || b.sfx));
  }
  return plan;
}

export function validateScenePlan(plan, raw, { total, lang = "en", narrator = false } = {}) {
  const assets = withDefaults(raw);
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.scenes)) return ["plan must be an object with a scenes array"];
  const issues = [];
  const scenes = plan.scenes;
  const chars = assets.poses;
  const propIds = new Set(assets.props);
  const sfx = new Set(assets.sfx);
  const max = lineMax(lang);
  const risky = (label, text) => {
    for (const f of riskFindings(String(text ?? ""))) issues.push(`${label} has a risk word: ${f.matched}`);
  };
  if (scenes.length < SCENES_MIN || scenes.length > SCENES_MAX) issues.push(`scenes must be ${SCENES_MIN}–${SCENES_MAX} (got ${scenes.length})`);
  const seen = new Set();
  const pr = assets.product;
  const imageIds = new Set((pr?.images ?? []).map((im) => im.id));
  const banned = (label, t) => {
    for (const w of forbiddenHits(pr, t)) issues.push(`${label} uses a forbidden claim: ${w}`);
  };
  const lineCheck = (label, l) => {
    if (typeof l?.text !== "string" || !l.text.trim()) return issues.push(`${label}: text must not be empty`);
    const n = narrationSize(lang, l.text);
    if (n > max) issues.push(`${label} is too long: ${n} ${unitEn(lang)} > ${max} (one line must fit about ${LINE_SECONDS - 1}s); shorten or split it`);
    risky(`${label} text`, l.text);
    banned(label, l.text);
  };
  // insert/endcard: รูปสินค้าจริงเต็มจอ ไม่มีตัวละคร บทเป็นเสียงผู้บรรยาย
  const productCard = (sc, i, tag, kind) => {
    if (arr(sc.cast).length || arr(sc.props).length || arr(sc.beats).length) issues.push(`${tag}: ${kind} scenes have empty cast, props and beats`);
    if (kind === "insert") {
      if (!imageIds.has(sc.image)) issues.push(`${tag}: insert image "${sc.image}" must be one of ${[...imageIds].join(", ")}`);
      const chip = typeof sc.chip === "string" ? sc.chip.trim() : "";
      if ([...chip].length > CHIP_MAX) issues.push(`${tag}: chip "${chip}" is ${[...chip].length} characters, max ${CHIP_MAX}`);
      banned(`${tag} chip`, chip);
      risky(`${tag} chip`, chip);
    } else if (i !== scenes.length - 1) issues.push(`${tag}: endcard must be the last scene`);
    arr(sc.lines).forEach((l, j) => {
      const label = `${tag} line ${j + 1}`;
      if (l?.who !== "narrator" || !narrator) issues.push(`${label}: ${kind} lines are spoken by the narrator${narrator ? "" : " (this project has no narrator: leave lines empty)"}`);
      lineCheck(label, l);
    });
    const secs = sceneSeconds(sc, lang);
    if (secs > SCENE_MAX) issues.push(`${tag} (scene ${i + 1}) is about ${secs.toFixed(1)}s, max ${SCENE_MAX}s: split it or cut lines`);
  };

  scenes.forEach((sc, i) => {
    const tag = typeof sc?.id === "string" && sc.id.trim() ? sc.id : `scene ${i + 1}`;
    if (sc === null || typeof sc !== "object") return issues.push(`${tag} must be an object`);
    if (typeof sc.id !== "string" || !sc.id.trim()) issues.push(`${tag}: id must be a non-empty string`);
    else if (seen.has(sc.id)) issues.push(`${tag}: duplicate scene id`);
    seen.add(sc.id);

    if (pr && sc.kind !== undefined && !KINDS.includes(sc.kind)) issues.push(`${tag}: kind "${sc.kind}" must be one of ${KINDS.join(", ")}`);
    if (!pr && sc.kind !== undefined && sc.kind !== "scene") issues.push(`${tag}: kind "${sc.kind}" needs a product (this project has none)`);
    const kind = kindOf(sc);
    if (kind !== "scene") return productCard(sc, i, tag, kind);
    if (sc.shot !== undefined && !SHOTS.includes(sc.shot)) issues.push(`${tag}: shot "${sc.shot}" must be one of ${SHOTS.join(", ")}`);
    if ((sc.shot === "close" || sc.shot === "low") && !arr(sc.cast).some((c) => c?.who === sc.focus)) {
      issues.push(`${tag}: shot "${sc.shot}" needs focus set to a character in this scene's cast`);
    }

    const placeOk = Object.hasOwn(assets.places, sc.place ?? "");
    if (!placeOk) issues.push(`${tag}: place "${sc.place}" does not exist (have: ${Object.keys(assets.places).join(", ")})`);
    const spots = placeOk ? assets.places[sc.place] : null;
    const spotCheck = (label, spot) => {
      if (spots && !spots.includes(spot)) issues.push(`${label}: spot "${spot}" is not a spot in ${sc.place} (have: ${spots.join(", ")})`);
    };
    if (!CAMERAS.includes(sc.camera)) issues.push(`${tag}: camera "${sc.camera}" must be one of ${CAMERAS.join(", ")}`);
    const enterCheck = (label, e) => {
      if (e !== undefined && e !== null && e !== "" && !ENTERS.includes(e)) issues.push(`${label}: enter "${e}" must be one of ${ENTERS.join(", ")}`);
    };
    const sizeCheck = (label, v) => {
      if (v !== undefined && !(typeof v === "number" && v > 0 && v <= 1)) issues.push(`${label}: size must be a number in (0, 1]`);
    };

    const props = Array.isArray(sc.props) ? sc.props : [];
    const inProps = new Set();
    props.forEach((p, j) => {
      const label = `${tag} prop ${j + 1}`;
      if (!propIds.has(p?.id)) issues.push(`${label}: prop "${p?.id}" does not exist (have: ${[...propIds].join(", ") || "none"})`);
      else if (inProps.has(p.id)) issues.push(`${label}: prop "${p.id}" appears twice`);
      inProps.add(p?.id);
      spotCheck(label, p?.spot);
      enterCheck(label, p?.enter);
      sizeCheck(label, p?.size);
    });

    const cast = Array.isArray(sc.cast) ? sc.cast : [];
    if (cast.length < 1 || cast.length > MAX_CAST) issues.push(`${tag}: cast must have 1–${MAX_CAST} characters (got ${cast.length})`);
    const inCast = new Set();
    cast.forEach((c, j) => {
      const label = `${tag} cast ${j + 1}`;
      const who = c?.who;
      if (!Object.hasOwn(chars, who ?? "")) issues.push(`${label}: character "${who}" does not exist (have: ${Object.keys(chars).join(", ")})`);
      else {
        if (inCast.has(who)) issues.push(`${label}: ${who} appears twice in cast`);
        if (!chars[who].includes(c.pose)) issues.push(`${label}: pose "${c.pose}" is not available for ${who} (has: ${chars[who].join(", ")})`);
      }
      if (Object.hasOwn(chars, who ?? "")) inCast.add(who);
      spotCheck(label, c?.spot);
      enterCheck(label, c?.enter);
      sizeCheck(label, c?.size);
      if (c?.ride !== undefined && c.ride !== null && c.ride !== "" && !inProps.has(c.ride)) {
        issues.push(`${label}: ${who} rides "${c.ride}" but that prop is not in this scene's props`);
      }
    });

    for (const id of inProps) if (inCast.has(id)) issues.push(`${tag}: prop id "${id}" is also a character in this scene; beats cannot tell them apart`);

    const lines = Array.isArray(sc.lines) ? sc.lines : [];
    if (!Array.isArray(sc.lines)) issues.push(`${tag}: lines must be an array (may be empty)`);
    lines.forEach((l, j) => {
      const label = `${tag} line ${j + 1}`;
      if (l?.who === "narrator") {
        if (!narrator) issues.push(`${label}: this project has no narrator; give the line to a character in the cast`);
      } else if (!inCast.has(l?.who)) issues.push(`${label}: speaker "${l?.who}" is not in this scene's cast`);
      lineCheck(label, l);
    });

    const beats = Array.isArray(sc.beats) ? sc.beats : [];
    beats.forEach((b, j) => {
      const label = `${tag} beat ${j + 1}`;
      const bad = atIssue(b?.at, lines.length);
      if (bad) issues.push(`${label}: ${bad}`);
      const who = b?.who;
      const isChar = inCast.has(who), isProp = inProps.has(who);
      if (who !== undefined && who !== null && who !== "" && !isChar && !isProp) issues.push(`${label}: "${who}" is not in this scene's cast or props`);
      if (b?.pose) {
        if (isProp) issues.push(`${label}: prop "${who}" has no poses`);
        else if (isChar && !chars[who].includes(b.pose)) issues.push(`${label}: pose "${b.pose}" is not available for ${who} (has: ${chars[who].join(", ")})`);
        else if (!who) issues.push(`${label}: pose needs who`);
      }
      if (b?.move) {
        if (!MOVES.includes(b.move)) issues.push(`${label}: move "${b.move}" must be one of ${MOVES.join(", ")}`);
        if (!who) issues.push(`${label}: move needs who`);
        if (b.move === "to" || b.move === "run-to") {
          if (!b.to_spot) issues.push(`${label}: move "${b.move}" needs to_spot`);
          else spotCheck(label, b.to_spot);
        }
      }
      if (b?.dur !== undefined && !(typeof b.dur === "number" && b.dur > 0)) issues.push(`${label}: dur must be a positive number of seconds`);
      if (b?.fx && !FX.includes(b.fx)) issues.push(`${label}: fx "${b.fx}" must be one of ${FX.join(", ")}`);
      if (b?.fx === "stamp") {
        const t = typeof b.text === "string" ? b.text.trim() : "";
        if (!t) issues.push(`${label}: stamp needs text (at most ${STAMP_MAX} characters)`);
        else if ([...t].length > STAMP_MAX) issues.push(`${label}: stamp text "${t}" is ${[...t].length} characters, max ${STAMP_MAX}`);
      }
      if (b?.sfx && !sfx.has(b.sfx)) issues.push(`${label}: sfx "${b.sfx}" must be one of ${[...sfx].join(", ")}`);
      risky(`${label} text`, b?.text);
      banned(label, b?.text);
    });

    const secs = sceneSeconds(sc, lang);
    if (secs > SCENE_MAX) issues.push(`${tag} (scene ${i + 1}) is about ${secs.toFixed(1)}s, max ${SCENE_MAX}s: split it or cut lines`);
  });

  const placeIds = Object.keys(assets.places);
  const used = uniq(scenes.map((sc) => sc?.place).filter((p) => Object.hasOwn(assets.places, p ?? "")));
  if (pr) {
    const kinds = scenes.map(kindOf);
    const inserts = scenes.filter((sc) => kindOf(sc) === "insert");
    if (kinds.filter((k) => k === "endcard").length !== 1) issues.push("a product clip needs exactly one endcard scene, last");
    if (new Set(inserts.map((sc) => sc.image)).size < Math.min(INSERTS_MIN, imageIds.size)) {
      issues.push(`a product clip needs at least ${INSERTS_MIN} insert scenes with different images (have ${inserts.length})`);
    }
    const hero = pr.images.find((im) => im.role === "hero")?.id;
    const first = inserts[0];
    if (first && first.image !== hero) issues.push(`the first insert must show the hero image "${hero}" (it shows "${first.image}")`);
    const shots = scenes.map((sc) => (kindOf(sc) === "scene" ? sc.shot ?? "wide" : kindOf(sc)));
    for (let k = 2; k < shots.length; k++) {
      if (kinds[k] === "scene" && shots[k] === shots[k - 1] && shots[k] === shots[k - 2]) {
        issues.push(`scenes ${k - 1}–${k + 1} all use shot "${shots[k]}": vary the shot`);
        break;
      }
    }
  } else if (placeIds.length >= 2 && scenes.length >= MULTI_PLACE_SCENES && used.length === 1) {
    issues.push(`all ${scenes.length} scenes are in ${used[0]}: move the story through 2–3 places (have: ${placeIds.join(", ")})`);
  }

  if (Number.isFinite(total)) {
    const est = estimateSeconds(plan, lang);
    if (Math.abs(est - total) > total * TOTAL_TOLERANCE) {
      issues.push(`estimated ${est.toFixed(1)}s, target ${total}s (±${TOTAL_TOLERANCE * 100}%): ${est < total ? "add lines or scenes" : "cut lines or scenes"}`);
    }
  }
  return issues;
}
