import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parse, VfError, log } from "./out.mjs";
import { resolveProject, stamp } from "./paths.mjs";
import { llmJson } from "./llm.mjs";
import { pickBest, toQaImage } from "./qa.mjs";
import { RULES } from "./qa-rules.mjs";
import { openState, step } from "./state.mjs";
import {
  CHARACTER_SCHEMA, validateCharacter, characterAddSystemPrompt, lookFromImageSystemPrompt, addCharacterFiles, ID_RE,
} from "./bible.mjs";
import { useUserImage, toPng, makeRef, sha, CANDIDATES } from "./project-create.mjs";
import {
  pinInput, pinRun, costSince, pickArchiveName, commitStagedRefs, clearStaged, stagedName, contextMessage, loadProject, parseImagePaths,
  planRows, llmRow, imageRow, qaRow, runEntity,
} from "./entities.mjs";

const OPTIONS = {
  prompt: { type: "string" },
  image: { type: "string", multiple: true },
  id: { type: "string" },
  replace: { type: "boolean" },
  foreground: { type: "boolean" },
  "dry-run": { type: "boolean" },
};
const MAX_STYLE_REFS = 2;

function dryRun(images) {
  const rows = [llmRow(4000, 600)];
  if (images.length) rows.push(qaRow(1));
  else rows.push(imageRow("character-ref", CANDIDATES), qaRow(CANDIDATES));
  return {
    dry_run: true,
    ...planRows(rows),
    assumptions: [
      "LLM ใช้ 4000 tokens เข้า (PROJECT.md + prompt) / 600 tokens ออก",
      images.length
        ? "ใช้ภาพของผู้ใช้เป็น ref หลัก ไม่สร้างภาพใหม่ · QA 1 ครั้งที่ 1 MP"
        : `ภาพตัวละคร ${CANDIDATES} แบบ (ไม่มี reroll) · QA 1500 tokens ต่อภาพ ที่ 1 MP`,
    ],
  };
}

async function qaUserImage(dir, ref, char, style, meta, costDir) {
  try {
    const { ranked } = await pickBest([{ file: join(dir, ref) }], RULES.characterFromImage, { look: char.look, style }, { meta, costDir });
    const v = ranked[0].verdict;
    return v.pass ? {} : { warning: `ภาพของผู้ใช้ไม่ผ่านเกณฑ์ QA: ${v.reasons.join(", ")} — ยังใช้ภาพนี้` };
  } catch (e) {
    if (e instanceof VfError && ["PROVIDER", "INTERNAL"].includes(e.code)) return { warning: `QA ภาพของผู้ใช้ทำไม่สำเร็จ: ${e.message}` };
    throw e;
  }
}

async function work({ dir, ctx, state, key, prompt, images, id, replace, run: fresh }) {
  const { pj, slug, lang, characters, places } = ctx;
  const run = pinRun(state, fresh);
  const costDir = join(dir, ".vf");
  const taken = new Set([...characters, ...places].map((x) => x.id));
  if (replace) taken.delete(id);

  const char = await step(state, "design", async () => {
    log("ขั้น design");
    const pics = await Promise.all(images.map((p) => toQaImage(p)));
    const notes = images.length ? [`ภาพที่แนบมา ${images.length} ภาพ เป็นภาพของตัวละครนี้ (ภาพแรกคือภาพหลัก)`] : [];
    const { data } = await llmJson({
      system: images.length ? lookFromImageSystemPrompt(lang) : characterAddSystemPrompt(lang),
      user: contextMessage({ dir, characters, places, prompt, id, notes }),
      schema: CHARACTER_SCHEMA,
      validate: (c) => validateCharacter(id && c && typeof c === "object" ? { ...c, id } : c, taken),
      images: pics.length ? pics : undefined,
      meta: { project: slug, step: "character", item: id ?? null, run },
      costDir,
    });
    return id ? { ...data, id } : data;
  });
  const cid = char.id;

  // ชื่อโฟลเดอร์เก็บของเดิม เลือกไว้ก่อน (ยังไม่ย้ายอะไร) และใช้เป็นเกลือของ seed เพื่อให้ได้ภาพชุดใหม่
  const archiveName = replace
    ? (await step(state, "archive-name", async () => ({ name: pickArchiveName(join(dir, "characters", cid, "ref"), stamp()) }))).name
    : undefined;

  // สร้างภาพใหม่ไว้ที่ ref/.new-* ก่อน ของเดิมยังไม่ถูกแตะจนกว่าทุกอย่างสำเร็จ
  const stagedMain = `characters/${cid}/ref/${stagedName("main.png")}`;
  let made, warning, extras = [];
  if (images.length) {
    made = await step(state, "images", async () => {
      log("ขั้น images");
      clearStaged(dir, cid);
      const first = await useUserImage(dir, cid, images[0], { dest: stagedMain });
      const more = [];
      for (let i = 1; i < images.length; i++) {
        await toPng(images[i], join(dir, `characters/${cid}/ref/${stagedName(`extra-${i}.png`)}`));
        more.push(`characters/${cid}/ref/extra-${i}.png`);
      }
      return { ref: first.ref, entryId: first.entry.id, extras: more };
    });
    extras = made.extras;
    ({ warning } = await step(state, "qa", async () => {
      log("ขั้น qa");
      return await qaUserImage(dir, stagedMain, char, pj.style_prompt, { project: slug, step: "qa", item: cid, run }, costDir);
    }));
  } else {
    made = await step(state, `ref:${cid}`, async () => {
      log(`ขั้น ref:${cid}`);
      clearStaged(dir, cid);
      const styleRefs = characters
        .filter((c) => c.id !== cid)
        .map((c) => join(dir, "characters", c.id, "ref", "main.png"))
        .filter((f) => existsSync(f))
        .slice(0, MAX_STYLE_REFS);
      return await makeRef(dir, slug, { style_prompt: pj.style_prompt }, char, costDir, {
        refs: styleRefs, dest: stagedMain, run, seedKey: archiveName ? `${cid}:${archiveName}` : undefined,
      });
    });
    warning = made.warning;
  }
  const ref = made.ref;

  await step(state, "files", async () => {
    log("ขั้น files");
    addCharacterFiles(dir, char, {
      ref, extras, replace,
      commit: () => commitStagedRefs(dir, cid, { entryId: made.entryId, archiveName, demoteTo: replace ? "replaced" : "candidate" }),
    });
    return { done: true, id: cid };
  });

  return {
    character: { id: cid, ref, look: char.look, ...(extras.length ? { extras } : {}), ...(warning ? { warning } : {}) },
    cost: { usd: costSince(costDir, run) },
    next: [`vf project show ${slug}`],
  };
}

export async function main(argv) {
  const { values, positionals } = parse(argv, OPTIONS);
  const prompt = values.prompt?.trim();
  if (!prompt) throw new VfError("USAGE", 'ต้องระบุ --prompt "..."');
  const id = values.id;
  const replace = values.replace === true;
  if (id !== undefined && !ID_RE.test(id)) throw new VfError("USAGE", "--id ต้องเป็น a-z 0-9 และ - ขึ้นต้นด้วยตัวอักษร ยาว 2–31 ตัว");
  const images = parseImagePaths(values.image ?? []);
  const dir = resolveProject(positionals[0]);
  const ctx = loadProject(dir);

  if (replace && !id) throw new VfError("USAGE", "--replace ต้องใช้คู่กับ --id <id ของตัวละครที่จะแทนที่>");
  if (id) {
    if (ctx.places.some((p) => p.id === id)) throw new VfError("USAGE", `id "${id}" เป็นสถานที่อยู่แล้ว เลือก --id อื่น`);
    const exists = ctx.characters.some((c) => c.id === id);
    if (replace && !exists) throw new VfError("USAGE", `ไม่มีตัวละคร "${id}" ให้แทนที่ (เอา --replace ออกเพื่อเพิ่มใหม่)`);
    if (!replace && exists) throw new VfError("USAGE", `มีตัวละคร "${id}" แล้ว ใช้ --replace เพื่อแทนที่ (ภาพเดิมจะถูกเก็บไว้ใน ref/old-*) หรือเลือก --id อื่น`);
  }
  if (values["dry-run"]) return dryRun(images);

  const imageSigs = images.map((p) => `${p}#${sha(readFileSync(p)).slice(0, 12)}`);
  const promptSha = sha(prompt);
  const key = id ?? `h${sha(JSON.stringify([promptSha, imageSigs])).slice(0, 8)}`;
  const stateDir = join(dir, ".vf");
  const stateName = `character-${key}-state.json`;

  // เปิด state และ pin input เฉพาะตอนรันจริง (foreground/worker) ไม่ทำใน parent ก่อนสร้าง job
  const openRun = () => {
    let state = openState(stateDir, stateName);
    if (state.get("files")?.status === "done") {
      if (!replace) throw new VfError("USAGE", `เพิ่มตัวละครนี้เสร็จแล้ว: ${state.get("files").output.id}`);
      renameSync(join(stateDir, stateName), join(stateDir, `character-${key}-state.${stamp()}-${Date.now()}.json`));
      state = openState(stateDir, stateName);
    }
    mkdirSync(stateDir, { recursive: true });
    pinInput(state, { prompt_sha: promptSha, images: imageSigs, id: id ?? null, replace }, ["prompt_sha", "images", "id", "replace"],
      "ของคำสั่งนี้ที่ทำค้างไว้ ให้ใช้ input เดิมเพื่อทำต่อ หรือเปลี่ยน --id เพื่อเริ่มใหม่");
    return state;
  };

  const command = [
    "character", "add", dir, `--prompt=${prompt}`,
    ...images.map((p) => `--image=${p}`),
    ...(id ? [`--id=${id}`] : []),
    ...(replace ? ["--replace"] : []),
  ];
  return await runEntity({
    dir, projectRef: positionals[0], slug: ctx.slug, command, label: `character add ${key}`, foreground: values.foreground,
    work: ({ run }) => work({ dir, ctx, state: openRun(), key, prompt, images, id, replace, run }),
  });
}
