import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse, VfError, log } from "./out.mjs";
import { resolveProject } from "./paths.mjs";
import { llmJson } from "./llm.mjs";
import { openState, step } from "./state.mjs";
import { PLACE_SCHEMA, validatePlace, placeAddSystemPrompt, addPlaceFiles, ID_RE } from "./bible.mjs";
import { makePlate, sha } from "./project-create.mjs";
import { pinInput, costSince, contextMessage, loadProject, planRows, llmRow, imageRow, qaRow, runEntity } from "./entities.mjs";

const OPTIONS = {
  prompt: { type: "string" },
  id: { type: "string" },
  "max-rerolls": { type: "string" },
  foreground: { type: "boolean" },
  "dry-run": { type: "boolean" },
};

function dryRun() {
  return {
    dry_run: true,
    ...planRows([llmRow(4000, 300), imageRow("place-plate", 1), qaRow(1)]),
    assumptions: [
      "LLM ใช้ 4000 tokens เข้า (PROJECT.md + prompt) / 300 tokens ออก",
      "ภาพฉาก 1 ครั้ง (ไม่มี reroll) · QA 1500 tokens ต่อภาพ ที่ 1 MP",
    ],
  };
}

async function work({ dir, ctx, state, key, prompt, id, maxRerolls, run }) {
  const { pj, slug, lang, characters, places } = ctx;
  const costDir = join(dir, ".vf");
  const taken = new Set([...characters, ...places].map((x) => x.id));

  const place = await step(state, "design", async () => {
    log("ขั้น design");
    const user = contextMessage({ dir, characters, places, prompt, id });
    const { data } = await llmJson({
      system: placeAddSystemPrompt(lang), user, schema: PLACE_SCHEMA,
      validate: (p) => validatePlace(id && p && typeof p === "object" ? { ...p, id } : p, taken),
      meta: { project: slug, step: `place:${key}`, run }, costDir,
    });
    return id ? { ...data, id } : data;
  });

  const { plate, warning } = await step(state, `plate:${place.id}`, async () => {
    log(`ขั้น plate:${place.id}`);
    return await makePlate(dir, slug, { style_prompt: pj.style_prompt }, place, pj.aspect ?? "9:16", maxRerolls, costDir, { run });
  });

  await step(state, "files", async () => {
    log("ขั้น files");
    addPlaceFiles(dir, place, { plate });
    return { done: true, id: place.id };
  });

  return {
    place: { id: place.id, plate, ...(warning ? { warning } : {}) },
    cost: { usd: costSince(costDir, run) },
    next: [`vf project show ${slug}`],
  };
}

export async function main(argv) {
  const { values, positionals } = parse(argv, OPTIONS);
  const prompt = values.prompt?.trim();
  if (!prompt) throw new VfError("USAGE", 'ต้องระบุ --prompt "..."');
  const id = values.id;
  if (id !== undefined && !ID_RE.test(id)) throw new VfError("USAGE", "--id ต้องเป็น a-z 0-9 และ - ขึ้นต้นด้วยตัวอักษร ยาว 2–31 ตัว");
  const maxRerolls = values["max-rerolls"] === undefined ? 2 : Number(values["max-rerolls"]);
  if (!Number.isInteger(maxRerolls) || maxRerolls < 0 || maxRerolls > 5) throw new VfError("USAGE", "--max-rerolls ต้องเป็นจำนวนเต็ม 0–5");
  const dir = resolveProject(positionals[0]);
  const ctx = loadProject(dir);
  if (id && [...ctx.characters, ...ctx.places].some((x) => x.id === id)) {
    throw new VfError("USAGE", `id "${id}" มีอยู่แล้วใน project นี้ เลือก --id อื่น`);
  }
  if (values["dry-run"]) return dryRun();

  const promptSha = sha(prompt);
  const key = id ?? `h${promptSha.slice(0, 8)}`;
  const stateDir = join(dir, ".vf");
  const openRun = () => {
    const state = openState(stateDir, `place-${key}-state.json`);
    if (state.get("files")?.status === "done") throw new VfError("USAGE", `เพิ่มสถานที่นี้เสร็จแล้ว: ${state.get("files").output.id}`);
    mkdirSync(stateDir, { recursive: true });
    pinInput(state, { prompt_sha: promptSha, id: id ?? null, max_rerolls: maxRerolls }, ["prompt_sha", "id", "max_rerolls"],
      "ของคำสั่งนี้ที่ทำค้างไว้ ให้ใช้ input เดิมเพื่อทำต่อ หรือเปลี่ยน --id เพื่อเริ่มใหม่");
    return state;
  };

  const command = ["place", "add", dir, `--prompt=${prompt}`, `--max-rerolls=${maxRerolls}`, ...(id ? [`--id=${id}`] : [])];
  return await runEntity({
    dir, projectRef: positionals[0], slug: ctx.slug, command, label: `place add ${key}`, foreground: values.foreground,
    work: ({ run }) => work({ dir, ctx, state: openRun(), key, prompt, id, maxRerolls, run }),
  });
}
