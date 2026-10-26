import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { VfError } from "./out.mjs";
import { readJson } from "./state.mjs";
import { startJob, registerJob, finishJob, isWorker, jobRootOf, startHeartbeat, resumeCommand } from "./jobs.mjs";
import { estimate } from "./pricing.mjs";
import { MODELS } from "./models.mjs";
import { readCosts, summarize } from "./cost.mjs";
import { libLoad, libUpdate } from "./cache.mjs";
import { llmJson } from "./llm.mjs";
import { pickBest, toQaImage, saveVerdicts } from "./qa.mjs";
import { RULES } from "./qa-rules.mjs";
import { CHARACTER_SCHEMA, characterAddSystemPrompt, lookFromImageSystemPrompt } from "./bible.mjs";


// บันทึก input ครั้งแรกไว้ใน state แล้วเทียบกับครั้งต่อไป; ต่างกัน → USAGE ระบุฟิลด์
export function pinInput(state, input, keys, hint) {
  const first = state.get("input");
  if (!first) {
    state.set("input", input);
    return;
  }
  for (const k of keys) {
    if (JSON.stringify(first[k]) !== JSON.stringify(input[k])) {
      const field = k === "prompt_sha" ? "prompt" : k;
      throw new VfError("USAGE", `${field} ต่างจากครั้งแรก ${hint}`);
    }
  }
}

// run id ของคำสั่งนี้: เก็บใน state ตอนเริ่มครั้งแรก แล้วใช้ค่าเดิมตอนรันซ้ำ (ต้นทุนรวมรอบที่พังด้วย)
export function pinRun(state, fresh) {
  const cur = state.get("run")?.id;
  if (cur) return cur;
  state.set("run", { id: fresh });
  return fresh;
}

// ต้นทุนของคำสั่งนี้เท่านั้น: แถวที่มี run id ของคำสั่งนี้
export function costSince(costDir, runId) {
  return summarize(readCosts(costDir).filter((r) => r.run === runId)).totalUsd;
}

const STAGE = ".new-";
export const stagedName = (name) => `${STAGE}${name}`;

export function clearStaged(projectDir, charId) {
  const refDir = join(projectDir, "characters", charId, "ref");
  if (!existsSync(refDir)) return;
  for (const n of readdirSync(refDir)) if (n.startsWith(STAGE)) rmSync(join(refDir, n), { force: true });
}

export function pickArchiveName(refDir, stamp) {
  let name = `old-${stamp}`;
  for (let n = 2; existsSync(join(refDir, name)); n++) name = `old-${stamp}-${n}`;
  return name;
}

// ย้ายภาพที่ stage ไว้เข้าที่ (ถ้า replace: เก็บของเดิมไว้ใน ref/<archiveName>/ ก่อน) แล้วตั้งสถานะในคลัง
// ทำซ้ำได้: ถ้าไม่มีไฟล์ stage เหลือ ก็ไม่ย้ายอะไรอีก (ไม่แตะภาพใหม่ที่เข้าที่แล้ว)
export function commitStagedRefs(projectDir, charId, { entryId, archiveName, demoteTo }) {
  const refDir = join(projectDir, "characters", charId, "ref");
  const staged = existsSync(refDir) ? readdirSync(refDir).filter((n) => n.startsWith(STAGE)) : [];
  const mainStaged = stagedName("main.png");
  // main.png ใหม่ย้ายเข้าที่เป็นอันสุดท้าย: ถ้ายังมี .new-main.png แปลว่ายังไม่เสร็จ
  // เก็บของเดิมเฉพาะตอนที่ main.png เดิมยังอยู่ (เก็บแล้วจะไม่เก็บซ้ำ จึงไม่ไปเก็บ extra ใหม่ที่ย้ายเข้าที่แล้ว)
  if (archiveName && staged.includes(mainStaged) && existsSync(join(refDir, "main.png"))) {
    const keep = readdirSync(refDir).filter((n) => !n.startsWith("old-") && !n.startsWith(STAGE));
    mkdirSync(join(refDir, archiveName), { recursive: true });
    for (const n of keep) renameSync(join(refDir, n), join(refDir, archiveName, n));
  }
  for (const n of staged.filter((x) => x !== mainStaged)) renameSync(join(refDir, n), join(refDir, n.slice(STAGE.length)));
  if (staged.includes(mainStaged)) renameSync(join(refDir, mainStaged), join(refDir, "main.png"));
  for (const e of libLoad(projectDir).entries) {
    if (e.id !== entryId && e.kind === "character-ref" && e.status === "selected" && (e.characters ?? []).includes(charId)) {
      libUpdate(projectDir, e.id, { status: demoteTo });
    }
  }
  libUpdate(projectDir, entryId, { status: "selected" });
}

// ออกแบบตัวละครด้วย LLM; มีภาพ → LLM vision เขียน look จากภาพ (ใช้ทั้ง character add และ project create --image)
export async function designCharacter({ lang, user, images = [], validate, meta, costDir }) {
  const pics = await Promise.all(images.map((p) => toQaImage(p)));
  const { data } = await llmJson({
    system: images.length ? lookFromImageSystemPrompt(lang) : characterAddSystemPrompt(lang),
    user,
    schema: CHARACTER_SCHEMA,
    validate,
    images: pics.length ? pics : undefined,
    meta,
    costDir,
  });
  return data;
}

// QA ภาพของผู้ใช้ (ตัวเดียว ไม่มีตัวอักษร): ไม่ผ่านหรือ QA ล้ม = warning ไม่ใช่ error · เก็บผลลงคลังถ้ารู้ entry
export async function qaUserImage(dir, ref, { style, entryId, meta, costDir }) {
  try {
    const { ranked } = await pickBest([{ file: join(dir, ref), entry: entryId ? { id: entryId } : undefined }], RULES.characterFromImage, { style }, { meta, costDir });
    saveVerdicts(dir, ranked);
    const v = ranked[0].verdict;
    return v.pass ? {} : { warning: `ภาพของผู้ใช้ไม่ผ่านเกณฑ์ QA: ${v.reasons.join(", ")} — ยังใช้ภาพนี้` };
  } catch (e) {
    if (e instanceof VfError && ["PROVIDER", "INTERNAL"].includes(e.code)) return { warning: `QA ภาพของผู้ใช้ทำไม่สำเร็จ: ${e.message}` };
    throw e;
  }
}

export function readProjectMd(dir) {
  const f = join(dir, "PROJECT.md");
  return existsSync(f) ? readFileSync(f, "utf8") : "(ไม่มี PROJECT.md)";
}

export function contextMessage({ dir, characters, places, id, prompt, notes = [] }) {
  return [
    "[PROJECT.md]",
    readProjectMd(dir),
    "",
    `id ตัวละครที่มีอยู่แล้ว (ห้ามซ้ำ): ${characters.map((c) => c.id).join(", ") || "(ไม่มี)"}`,
    `id สถานที่ที่มีอยู่แล้ว (ห้ามซ้ำ): ${places.map((p) => p.id).join(", ") || "(ไม่มี)"}`,
    ...(id ? [`ต้องใช้ id นี้เท่านั้น: ${id}`] : []),
    ...notes,
    "",
    "คำขอของผู้ใช้:",
    prompt,
  ].join("\n");
}

export function loadProject(dir) {
  let pj;
  try {
    pj = readJson(join(dir, "project.json"));
  } catch (e) {
    if (e.code === "ENOENT") throw new VfError("USAGE", `ไม่พบ project.json ใน ${dir} (project ยังสร้างไม่เสร็จ?)`);
    throw e;
  }
  return {
    pj,
    slug: pj.slug ?? basename(dir),
    lang: pj.lang ?? "en",
    characters: Array.isArray(pj.characters) ? pj.characters : [],
    places: Array.isArray(pj.places) ? pj.places : [],
  };
}

export function parseImagePaths(list = [], max = 4) {
  if (list.length > max) throw new VfError("USAGE", `--image ใส่ได้ไม่เกิน ${max} ภาพ (ส่งมา ${list.length})`);
  return list.map((p) => {
    let ok = false;
    try {
      ok = statSync(p).isFile();
    } catch {}
    if (!ok) throw new VfError("USAGE", `ไม่พบไฟล์ภาพ (ต้องเป็นไฟล์): ${p}`);
    return resolve(p);
  });
}

export function planRows(rows) {
  return {
    planned: rows.map(({ step, model, count }) => ({ step, model, count })),
    estimated_usd: rows.reduce((s, r) => s + (r.usd ?? 0), 0),
  };
}

export const llmRow = (tokensIn, tokensOut) => ({ step: "design", model: MODELS.llm[0], count: 1, usd: estimate(MODELS.llm[0], { tokensIn, tokensOut }) });
export const imageRow = (step, n) => ({ step, model: MODELS.image, count: n, usd: estimate(MODELS.image, { images: n, mp: 1 }) });
export const qaRow = (n) => ({ step: "qa", model: MODELS.qa, count: n, usd: estimate(MODELS.qa, { tokensIn: 1500 * n, tokensOut: 0 }) });

// ไม่มี --foreground → job; มี → รัน work ในโปรเซสนี้ โดยลงทะเบียนเป็น job ใต้ lock เดียวกับ startJob
// (worker ที่ถูก spawn มี job ของตัวเองอยู่แล้ว จึงไม่ลงทะเบียนซ้ำ) แนบ details.resume เมื่อพัง
export async function runEntity({ dir, projectRef, slug, command, label, foreground, work, jobExtra = {} }) {
  if (!foreground) {
    mkdirSync(join(dir, ".jobs"), { recursive: true });
    const job = startJob({ jobRoot: jobRootOf(dir), command, label });
    return { project: slug, ...jobExtra, job: { id: job.id, dir: job.dir, status: job.status }, next: [`vf wait ${projectRef} ${job.id}`] };
  }
  let reg = null;
  if (!isWorker()) {
    mkdirSync(join(dir, ".jobs"), { recursive: true });
    reg = registerJob({ jobRoot: jobRootOf(dir), command, label, pid: process.pid });
    reg.stopBeat = startHeartbeat(reg.dir);
  }
  const end = (outcome) => {
    if (!reg) return;
    reg.stopBeat();
    try {
      finishJob(reg.dir, outcome);
    } catch {}
  };
  try {
    const out = await work({ run: randomBytes(4).toString("hex") });
    end({ result: out });
    return out;
  } catch (e) {
    if (e instanceof VfError) e.details = { ...e.details, project: slug, resume: resumeCommand(command) };
    end({ error: { code: e instanceof VfError ? e.code : "INTERNAL", message: e?.message ?? String(e), details: e?.details } });
    throw e;
  }
}
