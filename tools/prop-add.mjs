import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, VfError } from "./out.mjs";
import { resolveProject, slugify } from "./paths.mjs";
import { openState } from "./state.mjs";
import { pinInput, pinRun, costSince, loadProject, planRows, imageRow, runEntity } from "./entities.mjs";
import { MODELS } from "./models.mjs";
import { importProp, makeProp, propDir, PLACEMENTS, PROP_ID_RE } from "./props.mjs";

const OPTIONS = {
  prompt: { type: "string" },
  id: { type: "string" },
  image: { type: "string" },
  placement: { type: "string" },
  "size-cm": { type: "string" },
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
  if (!ref || !desc) throw new VfError("USAGE", 'ใช้: vf prop add <project> --prompt "<คำอธิบายวัตถุ>" [--id <id>] [--image <png> --placement upright|floor --size-cm <N>]');
  const image = values.image ? resolve(values.image) : null;
  if (!image && (values.placement || values["size-cm"])) throw new VfError("USAGE", "--placement และ --size-cm ใช้คู่กับ --image เท่านั้น");
  const placement = values.placement ?? "upright";
  if (!PLACEMENTS.includes(placement)) throw new VfError("USAGE", `--placement ต้องเป็น ${PLACEMENTS.join(" หรือ ")}`);
  const sizeCm = values["size-cm"] === undefined ? null : Number(values["size-cm"]);
  const first3 = desc.split(/\s+/).slice(0, 3).join(" ");
  // slugify ของข้อความที่ไม่มี a-z0-9 จะคืน hash (project-xxxx) ซึ่งไม่ใช่ id ที่ตั้งใจ
  const id = values.id ?? (/[a-z0-9]/i.test(first3) ? slugify(first3) : "");
  if (!PROP_ID_RE.test(id)) throw new VfError("USAGE", `สร้าง id จากคำอธิบายไม่ได้ ("${id}") ให้ระบุ --id เป็น a-z0-9 และ - เช่น --id robot-vacuum`);
  const dir = resolveProject(ref);
  const ctx = loadProject(dir);
  if (existsSync(join(propDir(dir, id), "prop.json"))) throw new VfError("USAGE", `มี prop "${id}" แล้ว ใช้ --id อื่น`);
  // รูปจริง (เช่น สินค้า): ไม่เรียก API จึงทำทันที ไม่ต้องเป็น job
  if (image) {
    if (values["dry-run"]) return { dry_run: true, planned: [], estimated_usd: 0, assumptions: ["ใช้รูปที่ให้มา ตัดขอบใสในเครื่อง ไม่มีค่าใช้จ่าย"] };
    const made = await importProp({ dir, id, desc, image, placement, sizeCm });
    return { ...made, cost: { usd: 0 }, next: [`vf project show ${ctx.slug}`] };
  }
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
