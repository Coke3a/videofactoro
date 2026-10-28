import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parse, VfError, log } from "./out.mjs";
import { resolveProject, stamp } from "./paths.mjs";
import { openState, step, writeJsonAtomic } from "./state.mjs";
import { NO_PASS_WARNING } from "./qa.mjs";
import { pinInput, pinRun, costSince, loadProject, planRows, imageRow, qaRow, runEntity } from "./entities.mjs";
import { MODELS } from "./models.mjs";
import { DEFAULT_POSES, makePoses, posesDir } from "./poses.mjs";

const OPTIONS = {
  poses: { type: "string" },
  replace: { type: "boolean" },
  foreground: { type: "boolean" },
  "dry-run": { type: "boolean" },
};
const MAX_REROLLS = 1;

function pickPoses(list) {
  if (list === undefined) return DEFAULT_POSES;
  const names = list.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !(n in DEFAULT_POSES));
  if (!names.length || bad.length) {
    throw new VfError("USAGE", `--poses ไม่รู้จัก: ${bad.join(", ") || "(ว่าง)"} (ใช้ได้: ${Object.keys(DEFAULT_POSES).join(", ")})`);
  }
  return Object.fromEntries([...new Set(names)].map((n) => [n, DEFAULT_POSES[n]]));
}

function dryRun(n) {
  return {
    dry_run: true,
    ...planRows([imageRow("pose", n * 2, MODELS.imageFast), qaRow(n)]),
    assumptions: [
      `ท่าละ 1 ภาพ + ภาพอ้าปากพูด 1 ภาพ (รวม ${n * 2}) ด้วย ${MODELS.imageFast}`,
      `QA ${n} ครั้ง (ไม่นับ reroll สูงสุด ${MAX_REROLLS} ครั้งต่อท่า) · ตัดพื้นหลังในเครื่อง ไม่มีค่าใช้จ่าย`,
    ],
  };
}

async function work({ dir, ctx, state, char, poses, replace, run: fresh }) {
  const run = pinRun(state, fresh);
  const costDir = join(dir, ".vf");
  const out = posesDir(dir, char.id);

  // เก็บชุดเดิมไว้ก่อนสร้างใหม่ (ชื่อโฟลเดอร์ใช้เป็นเกลือ seed ให้ได้ภาพชุดใหม่ ไม่ชน cache)
  const archived = replace
    ? await step(state, "archive", async () => {
      if (!existsSync(out)) return { name: stamp() };
      const s = stamp();
      let name = `poses-old-${s}`;
      for (let n = 2; existsSync(join(dir, "characters", char.id, name)); n++) name = `poses-old-${s}-${n}`;
      renameSync(out, join(dir, "characters", char.id, name));
      return { name };
    })
    : undefined;

  const made = await makePoses({ dir, slug: ctx.slug, char, poses, maxRerolls: MAX_REROLLS, run, costDir, state, salt: archived ? `:${archived.name}` : "" });
  await step(state, "files", async () => {
    log("ขั้น files");
    mkdirSync(out, { recursive: true });
    writeJsonAtomic(join(out, "poses.json"), { character: char.id, poses: made.poses });
    return { done: true };
  });

  const warnings = Object.entries(made.poses).filter(([, p]) => !p.passed).map(([n]) => `${n}: ${NO_PASS_WARNING}`);
  return {
    character: char.id,
    poses: Object.keys(made.poses),
    ...(warnings.length ? { warnings } : {}),
    cost: { usd: costSince(costDir, run) },
    next: [`vf project show ${ctx.slug}`],
  };
}

export async function main(argv) {
  const { values, positionals } = parse(argv, OPTIONS);
  const [ref, cid] = positionals;
  if (!cid) throw new VfError("USAGE", "ใช้: vf character poses <project> <character> [--poses idle,happy] [--replace]");
  const replace = values.replace === true;
  const poses = pickPoses(values.poses);
  const dir = resolveProject(ref);
  const ctx = loadProject(dir);
  const char = ctx.characters.find((c) => c.id === cid);
  if (!char) throw new VfError("USAGE", `ไม่พบตัวละคร "${cid}" ใน project (ดู vf project show ${ctx.slug})`);
  if (!replace && existsSync(join(posesDir(dir, cid), "poses.json"))) {
    throw new VfError("USAGE", `มีท่าแล้ว ใช้ --replace เพื่อสร้างใหม่ (ชุดเดิมจะถูกเก็บไว้ใน poses-old-*): ${cid}`);
  }
  if (values["dry-run"]) return dryRun(Object.keys(poses).length);

  const stateDir = join(dir, ".vf");
  const stateName = `poses-${cid}-state.json`;
  const openRun = () => {
    let state = openState(stateDir, stateName);
    if (replace && state.get("files")?.status === "done") {
      renameSync(join(stateDir, stateName), join(stateDir, `poses-${cid}-state.${stamp()}-${Date.now()}.json`));
      state = openState(stateDir, stateName);
    }
    mkdirSync(stateDir, { recursive: true });
    pinInput(state, { poses: Object.keys(poses), replace }, ["poses", "replace"], "ของคำสั่งนี้ที่ทำค้างไว้ ให้ใช้ input เดิมเพื่อทำต่อ");
    return state;
  };
  const command = ["character", "poses", dir, cid, `--poses=${Object.keys(poses).join(",")}`, ...(replace ? ["--replace"] : [])];
  return await runEntity({
    dir, projectRef: ref, slug: ctx.slug, command, label: `character poses ${cid}`, foreground: values.foreground,
    work: ({ run }) => work({ dir, ctx, state: openRun(), char, poses, replace, run }),
  });
}
