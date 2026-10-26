import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, VfError, log } from "./out.mjs";
import { projectsRoot, slugify, NAME_RE } from "./paths.mjs";
import { llmJson } from "./llm.mjs";
import { generateImage } from "./images.mjs";
import { pickBest, generateWithQa, NO_PASS_WARNING } from "./qa.mjs";
import { RULES } from "./qa-rules.mjs";
import { openState, step } from "./state.mjs";
import { startJob, jobRootOf } from "./jobs.mjs";
import { libAdd, libLoad, libUpdate } from "./cache.mjs";
import { readCosts, summarize } from "./cost.mjs";
import { estimate } from "./pricing.mjs";
import { MODELS } from "./models.mjs";
import { pinInput, shq } from "./entities.mjs";
import { BIBLE_SCHEMA, validateBible, bibleSystemPrompt, writeProjectFiles } from "./bible.mjs";

const execFileP = promisify(execFile);
const ASPECTS = ["9:16", "16:9", "1:1"];
const PNG_MAGIC = 0x89504e47;
export const CANDIDATES = 3;
export const REF_SUFFIX = " Character reference: single character, full body, front view, neutral pose, plain light background.";
export const PLATE_SUFFIX = " Background plate: empty location, no people, no animals, wide establishing view.";
export const sha = (b) => createHash("sha256").update(b).digest("hex");

const OPTIONS = {
  prompt: { type: "string" },
  name: { type: "string" },
  lang: { type: "string" },
  aspect: { type: "string" },
  image: { type: "string", multiple: true },
  "max-rerolls": { type: "string" },
  foreground: { type: "boolean" },
  "dry-run": { type: "boolean" },
};

export const baseSeed = (slug, id) => parseInt(sha(`${slug}:${id}`).slice(0, 8), 16);
export const seedAt = (base, i) => (base + i) % 2 ** 32;

async function ffmpeg(args, what) {
  try {
    await execFileP("ffmpeg", ["-y", "-loglevel", "error", ...args]);
  } catch (err) {
    throw new VfError("INTERNAL", `แปลงภาพไม่สำเร็จ (${what})`, { cause: String(err?.message ?? err).slice(0, 200) });
  }
}

export async function convert(src, dest, outArgs, what) {
  mkdirSync(dirname(dest), { recursive: true });
  const ext = dest.slice(dest.lastIndexOf("."));
  const tmp = `${dest}.tmp-${process.pid}${ext}`;
  try {
    await ffmpeg(["-i", src, "-frames:v", "1", ...outArgs, tmp], what);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function toPng(src, dest) {
  const head = readFileSync(src).subarray(0, 4);
  if (head.length === 4 && head.readUInt32BE(0) === PNG_MAGIC) {
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    try {
      copyFileSync(src, tmp);
      renameSync(tmp, dest);
    } finally {
      rmSync(tmp, { force: true });
    }
    return;
  }
  await convert(src, dest, [], "png");
}

export async function useUserImage(projectDir, charId, srcPath) {
  if (!existsSync(srcPath)) throw new VfError("USAGE", `ไม่พบไฟล์ภาพ: ${srcPath}`);
  const rel = `characters/${charId}/ref/main.png`;
  await toPng(srcPath, join(projectDir, rel));
  const bytes = readFileSync(join(projectDir, rel));
  const id = `character-ref-user-${sha(bytes).slice(0, 12)}`;
  const lib = libLoad(projectDir);
  for (const e of lib.entries) {
    if (e.id !== id && e.kind === "character-ref" && e.status === "selected" && (e.characters ?? []).includes(charId)) {
      libUpdate(projectDir, e.id, { status: "candidate" });
    }
  }
  let entry = lib.entries.find((e) => e.id === id);
  if (!entry) {
    const added = libAdd(projectDir, {
      id, kind: "character-ref", key: `user:${sha(bytes)}`, prompt: "", need: "user image", model: null, refs: [],
      characters: [charId], place: null, tags: [], tag_p: {}, qa: null, status: "selected", used_in: [],
      cost_usd: 0, seed: null,
    }, bytes, "png");
    entry = libUpdate(projectDir, added.id, { file: added.blob });
  } else if (entry.status !== "selected") {
    entry = libUpdate(projectDir, id, { status: "selected" });
  }
  return { ref: rel, entry };
}

function parseImages(list = []) {
  return list.map((raw) => {
    const i = raw.indexOf("=");
    const name = i > 0 ? raw.slice(0, i).trim() : "";
    const path = i > 0 ? raw.slice(i + 1).trim() : "";
    if (!name || !path) throw new VfError("USAGE", `--image ต้องเป็นรูปแบบ <ชื่อตัวละคร>=<path>: ${raw}`);
    if (!existsSync(path)) throw new VfError("USAGE", `ไม่พบไฟล์ภาพของ --image ${name}: ${path}`);
    return { name, path: resolve(path) };
  });
}

function dryRun(images) {
  const chars = Math.max(3, images.length);
  const places = 2;
  const gen = Math.max(0, chars - images.length);
  const refImgs = gen * CANDIDATES;
  const rows = [
    { step: "bible", model: MODELS.llm[0], count: 1, usd: estimate(MODELS.llm[0], { tokensIn: 3000, tokensOut: 4000 }) },
    { step: "character-ref", model: MODELS.image, count: refImgs, usd: estimate(MODELS.image, { images: refImgs, mp: 1 }) },
    { step: "place-plate", model: MODELS.image, count: places, usd: estimate(MODELS.image, { images: places, mp: 1 }) },
    { step: "qa", model: MODELS.qa, count: refImgs + places, usd: estimate(MODELS.qa, { tokensIn: 1500 * (refImgs + places), tokensOut: 0 }) },
  ];
  const estimated_usd = rows.reduce((s, r) => s + (r.usd ?? 0), 0);
  return {
    dry_run: true,
    planned: rows.map(({ step: s, model, count }) => ({ step: s, model, count })),
    estimated_usd,
    assumptions: [
      `ตัวละคร ${chars} ตัว สถานที่ ${places} แห่ง (ค่าจริงขึ้นกับ bible ที่ LLM เขียน)`,
      "bible ใช้ 3000 tokens เข้า / 4000 tokens ออก",
      `ภาพตัวละคร ${CANDIDATES} แบบต่อตัว (ไม่นับตัวที่ใช้ --image: ${images.length} ตัว)`,
      "ภาพฉาก 1 ครั้งต่อสถานที่ (ไม่มี reroll)",
      "QA ใช้ 1500 tokens ต่อภาพ ที่ 1 MP",
    ],
  };
}

export async function makeRef(dir, slug, bible, c, costDir, { refs = [] } = {}) {
  const meta = { project: slug, step: `ref:${c.id}` };
  const prompt = `${c.look} ${bible.style_prompt}${REF_SUFFIX}`;
  const base = baseSeed(slug, c.id);
  const cands = [];
  for (let i = 0; i < CANDIDATES; i++) {
    cands.push(await generateImage({
      projectDir: dir, prompt, refs, aspect: "3:4", seed: seedAt(base, i), need: `ref:${c.id}`,
      kind: "character-ref", characters: [c.id], meta,
    }));
  }
  const { best } = await pickBest(cands, RULES.characterRef, { look: c.look, style: bible.style_prompt }, { meta, costDir });
  const rel = `characters/${c.id}/ref/main.png`;
  await toPng(best.file, join(dir, rel));
  const lib = libLoad(dir);
  for (const e of lib.entries) {
    if (e.kind === "character-ref" && e.status === "selected" && e.id !== best.entry.id && (e.characters ?? []).includes(c.id)) {
      libUpdate(dir, e.id, { status: "candidate" });
    }
  }
  libUpdate(dir, best.entry.id, { status: "selected" });
  return { ref: rel, ...(best.warning ? { warning: best.warning } : {}) };
}

export async function makePlate(dir, slug, bible, p, aspect, maxRerolls, costDir) {
  const meta = { project: slug, step: `plate:${p.id}` };
  const prompt = `${p.desc} ${bible.style_prompt}${PLATE_SUFFIX}`;
  const ctx = { desc: p.desc, style: bible.style_prompt };
  const base = baseSeed(slug, p.id);
  const res = await generateWithQa({
    maxRerolls,
    generate: (attempt) => generateImage({
      projectDir: dir, prompt, aspect, seed: seedAt(base, attempt), need: `plate:${p.id}`,
      kind: "place-plate", place: p.id, meta,
    }),
    check: async (c) => (await pickBest([c], RULES.placePlate, ctx, { meta, costDir })).ranked[0].verdict,
  });
  const rel = `places/${p.id}/plates/main.jpg`;
  await convert(res.best.file, join(dir, rel), ["-q:v", "3"], "jpg");
  libUpdate(dir, res.best.entry.id, { status: "selected" });
  return { plate: rel, ...(res.passed ? {} : { warning: NO_PASS_WARNING }) };
}

function matchImages(bible, images) {
  const byChar = {};
  const warnings = [];
  for (const im of images) {
    const key = im.name.toLowerCase();
    const c = bible.characters.find((x) => x.id.toLowerCase() === key || x.name.toLowerCase() === key);
    if (!c) warnings.push(`--image ${im.name}: ไม่พบตัวละครชื่อนี้ใน bible จึงไม่ใช้ภาพนี้`);
    else if (byChar[c.id]) warnings.push(`--image ${im.name}: ตัวละคร ${c.id} มีภาพแล้ว ใช้ภาพแรก`);
    else byChar[c.id] = im.path;
  }
  return { byChar, warnings };
}

async function work({ dir, slug, prompt, lang, aspect, images, maxRerolls }) {
  const costDir = join(dir, ".vf");
  const state = openState(costDir, "create-state.json");
  const required = images.map((i) => i.name);

  const bible = await step(state, "bible", async () => {
    log("ขั้น bible");
    const user = [
      prompt,
      "",
      `ภาษาของเรื่อง: ${lang} · สัดส่วนภาพ: ${aspect}`,
      ...(required.length ? [`ตัวละครที่ต้องมีในเรื่อง (ใช้ชื่อนี้เป็น name): ${required.join(", ")}`] : []),
    ].join("\n");
    const { data } = await llmJson({
      system: bibleSystemPrompt(lang), user, schema: BIBLE_SCHEMA, validate: validateBible,
      meta: { project: slug, step: "bible" }, costDir,
    });
    return { ...data, lang };
  });

  const { byChar, warnings } = matchImages(bible, images);
  const chars = [];
  for (const c of bible.characters) {
    chars.push({
      id: c.id,
      ...(await step(state, `ref:${c.id}`, async () => {
        log(`ขั้น ref:${c.id}`);
        if (byChar[c.id]) return { ref: (await useUserImage(dir, c.id, byChar[c.id])).ref };
        return await makeRef(dir, slug, bible, c, costDir);
      })),
    });
  }
  const places = [];
  for (const p of bible.places) {
    places.push({
      id: p.id,
      ...(await step(state, `plate:${p.id}`, async () => {
        log(`ขั้น plate:${p.id}`);
        return await makePlate(dir, slug, bible, p, aspect, maxRerolls, costDir);
      })),
    });
  }

  await step(state, "files", async () => {
    log("ขั้น files");
    writeProjectFiles(dir, bible, {
      slug, aspect, lang,
      selected: Object.fromEntries(chars.map((c) => [c.id, c.ref])),
      plates: Object.fromEntries(places.map((p) => [p.id, p.plate])),
    });
    return { done: true };
  });

  return {
    project: slug,
    dir,
    characters: chars,
    places,
    cost: { usd: summarize(readCosts(costDir)).totalUsd },
    ...(warnings.length ? { warnings } : {}),
    next: [`vf project show ${slug}`, `vf character add ${slug} --prompt ...`, `vf place add ${slug} --prompt ...`],
  };
}

export function buildCommand({ prompt, slug, lang, aspect, maxRerolls, images }) {
  return [
    "project", "create", `--prompt=${prompt}`, "--name", slug, "--lang", lang, "--aspect", aspect,
    "--max-rerolls", String(maxRerolls),
    ...images.map((i) => `--image=${i.name}=${i.path}`),
  ];
}

function checkInput(state, input) {
  pinInput(state, input, ["prompt_sha", "lang", "aspect", "images"], "ของ project นี้ ถ้าต้องการสร้างใหม่ให้ใช้ --name อื่น");
}

export async function main(argv) {
  const { values } = parse(argv, OPTIONS);
  const prompt = values.prompt?.trim();
  if (!prompt) throw new VfError("USAGE", 'ต้องระบุ --prompt "..."');
  const lang = values.lang ?? "en";
  const aspect = values.aspect ?? "9:16";
  if (!ASPECTS.includes(aspect)) throw new VfError("USAGE", `--aspect ต้องเป็นหนึ่งใน ${ASPECTS.join(", ")}`);
  const maxRerolls = values["max-rerolls"] === undefined ? 2 : Number(values["max-rerolls"]);
  if (!Number.isInteger(maxRerolls) || maxRerolls < 0 || maxRerolls > 5) throw new VfError("USAGE", "--max-rerolls ต้องเป็นจำนวนเต็ม 0–5");
  const images = parseImages(values.image);
  if (values.name !== undefined && !NAME_RE.test(values.name)) throw new VfError("USAGE", "--name ต้องเป็น a-z 0-9 และ - เท่านั้น");
  if (values["dry-run"]) return dryRun(images);

  const slug = values.name ?? slugify(prompt);
  const dir = join(projectsRoot(), slug);
  const stateDir = join(dir, ".vf");
  const state = openState(stateDir, "create-state.json");
  if (existsSync(join(stateDir, "create-state.json")) && state.get("files")?.status === "done") {
    throw new VfError("USAGE", `มี project นี้แล้ว: ${slug}`);
  }
  mkdirSync(stateDir, { recursive: true });
  checkInput(state, { prompt_sha: sha(prompt), lang, aspect, images: images.map((i) => `${i.name}=${i.path}`) });

  const command = buildCommand({ prompt, slug, lang, aspect, maxRerolls, images });
  if (!values.foreground) {
    mkdirSync(join(dir, ".jobs"), { recursive: true });
    const job = startJob({ jobRoot: jobRootOf(dir), command, label: `project create ${slug}` });
    return { project: slug, dir, job: { id: job.id, dir: job.dir, status: job.status }, next: [`vf wait ${slug} ${job.id}`] };
  }
  try {
    return await work({ dir, slug, prompt, lang, aspect, images, maxRerolls });
  } catch (e) {
    if (e instanceof VfError) {
      e.details = { ...e.details, project: slug, resume: `vf ${command.map(shq).join(" ")}` };
    }
    throw e;
  }
}
