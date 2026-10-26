import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { VfError } from "./out.mjs";
import { readJson } from "./state.mjs";
import { startJob, jobRootOf } from "./jobs.mjs";
import { estimate } from "./pricing.mjs";
import { MODELS } from "./models.mjs";
import { readCosts, summarize } from "./cost.mjs";
import { libLoad, libUpdate } from "./cache.mjs";

export const shq = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

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

// ต้นทุนของคำสั่งนี้เท่านั้น: แถวที่เขียนหลัง startedAt
export function costSince(costDir, startedAt) {
  return summarize(readCosts(costDir).filter((r) => r.at >= startedAt)).totalUsd;
}

// ย้ายทุกอย่างใน ref/ (ยกเว้น old-*) ไป ref/<dirName>/ แล้วเปลี่ยนสถานะ selected → replaced; ไม่ลบอะไร
export function pickArchiveName(refDir, stamp) {
  let name = `old-${stamp}`;
  for (let n = 2; existsSync(join(refDir, name)); n++) name = `old-${stamp}-${n}`;
  return name;
}

export function archiveCharacterRefs(projectDir, charId, dirName) {
  const refDir = join(projectDir, "characters", charId, "ref");
  const moved = [];
  if (existsSync(refDir)) {
    const names = readdirSync(refDir).filter((n) => !n.startsWith("old-"));
    if (names.length) mkdirSync(join(refDir, dirName), { recursive: true });
    for (const n of names) {
      renameSync(join(refDir, n), join(refDir, dirName, n));
      moved.push(n);
    }
  }
  for (const e of libLoad(projectDir).entries) {
    if (e.status === "selected" && (e.characters ?? []).includes(charId)) libUpdate(projectDir, e.id, { status: "replaced" });
  }
  return moved;
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
    if (!existsSync(p)) throw new VfError("USAGE", `ไม่พบไฟล์ภาพ: ${p}`);
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

// ไม่มี --foreground → job; มี → รัน work ในโปรเซสนี้ พร้อมแนบ details.resume เมื่อพัง
export async function runEntity({ dir, projectRef, slug, command, label, foreground, work }) {
  if (!foreground) {
    mkdirSync(join(dir, ".jobs"), { recursive: true });
    const job = startJob({ jobRoot: jobRootOf(dir), command, label });
    return { project: slug, job: { id: job.id, dir: job.dir, status: job.status }, next: [`vf wait ${projectRef} ${job.id}`] };
  }
  const startedAt = new Date().toISOString();
  try {
    return await work(startedAt);
  } catch (e) {
    if (e instanceof VfError) e.details = { ...e.details, project: slug, resume: `vf ${command.map(shq).join(" ")}` };
    throw e;
  }
}
