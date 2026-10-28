import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse, VfError } from "./out.mjs";
import { resolveProject, slugify } from "./paths.mjs";
import { openState } from "./state.mjs";
import { pinInput, pinRun, costSince, loadProject, planRows, imageRow, runEntity } from "./entities.mjs";
import { MODELS } from "./models.mjs";
import { makeProp, propDir, PROP_ID_RE } from "./props.mjs";

const OPTIONS = {
  prompt: { type: "string" },
  id: { type: "string" },
  foreground: { type: "boolean" },
  "dry-run": { type: "boolean" },
};

function dryRun() {
  return {
    dry_run: true,
    ...planRows([imageRow("prop", 1, MODELS.imageFast)]),
    assumptions: [`ภาพวัตถุ 1 ภาพด้วย ${MODELS.imageFast} · ไม่มี QA · ตัดพื้นหลังในเครื่อง ไม่มีค่าใช้จ่าย`],
  };
}

export async function main(argv) {
  const { values, positionals } = parse(argv, OPTIONS);
  const ref = positionals[0];
  const desc = values.prompt?.trim();
  if (!ref || !desc) throw new VfError("USAGE", 'ใช้: vf prop add <project> --prompt "<คำอธิบายวัตถุ>" [--id <id>]');
  const first3 = desc.split(/\s+/).slice(0, 3).join(" ");
  // slugify ของข้อความที่ไม่มี a-z0-9 จะคืน hash (project-xxxx) ซึ่งไม่ใช่ id ที่ตั้งใจ
  const id = values.id ?? (/[a-z0-9]/i.test(first3) ? slugify(first3) : "");
  if (!PROP_ID_RE.test(id)) throw new VfError("USAGE", `สร้าง id จากคำอธิบายไม่ได้ ("${id}") ให้ระบุ --id เป็น a-z0-9 และ - เช่น --id robot-vacuum`);
  const dir = resolveProject(ref);
  const ctx = loadProject(dir);
  if (existsSync(join(propDir(dir, id), "prop.json"))) throw new VfError("USAGE", `มี prop "${id}" แล้ว ใช้ --id อื่น`);
  if (values["dry-run"]) return dryRun();

  const command = ["prop", "add", dir, `--prompt=${desc}`, `--id=${id}`];
  return await runEntity({
    dir, projectRef: ref, slug: ctx.slug, command, label: `prop add ${id}`, foreground: values.foreground,
    work: async ({ run: fresh }) => {
      const stateDir = join(dir, ".vf");
      mkdirSync(stateDir, { recursive: true });
      const state = openState(stateDir, `prop-${id}-state.json`);
      pinInput(state, { id, desc }, ["id", "desc"], "ของคำสั่งนี้ที่ทำค้างไว้ ให้ใช้ input เดิมเพื่อทำต่อ");
      const run = pinRun(state, fresh);
      const costDir = stateDir;
      const made = await makeProp({ dir, slug: ctx.slug, id, desc, run, costDir, state });
      return { ...made, cost: { usd: costSince(costDir, run) }, next: [`vf project show ${ctx.slug}`] };
    },
  });
}
