import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parse, VfError, log } from "./out.mjs";
import { resolveProject, stamp } from "./paths.mjs";
import { openState, step, writeJsonAtomic } from "./state.mjs";
import { NO_PASS_WARNING } from "./qa.mjs";
import { pinInput, pinRun, costSince, loadProject, planRows, imageRow, qaRow, runEntity } from "./entities.mjs";
import { MODELS } from "./models.mjs";
import { DEFAULT_POSES, TALK_MAX_REROLLS, makePoses, posesDir } from "./poses.mjs";

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
  // QA ภาพอ้าปากส่ง 2 ภาพ จึงคิด token ของมันเป็น 2 เท่า (n + 2n)
  const qa = { ...qaRow(n * 2), usd: qaRow(n * 3).usd };
  return {
    dry_run: true,
    ...planRows([imageRow("pose", n * 2, MODELS.imageFast), qa]),
    assumptions: [
      `ท่าละ 1 ภาพ + ภาพอ้าปากพูด 1 ภาพ (รวม ${n * 2}) ด้วย ${MODELS.imageFast}`,
      `QA ${n * 2} ครั้ง (ท่า ${n} + ภาพอ้าปาก ${n}) ไม่นับ reroll: ท่าสูงสุด ${MAX_REROLLS} ครั้ง ภาพอ้าปากสูงสุด ${TALK_MAX_REROLLS} ครั้งต่อท่า (reroll ละ 1 ภาพ + 1 QA) · ตัดพื้นหลังในเครื่อง ไม่มีค่าใช้จ่าย`,
    ],
  };
}

function oldName(cdir) {
  const s = stamp();
  let name = `poses-old-${s}`;
  for (let n = 2; existsSync(join(cdir, name)); n++) name = `poses-old-${s}-${n}`;
  return name;
}

const readSet = (out) => (existsSync(join(out, "poses.json")) ? JSON.parse(readFileSync(join(out, "poses.json"), "utf8")).poses ?? {} : {});

// partial = --replace พร้อม --poses: ย้ายเฉพาะไฟล์ของท่าที่ระบุ (poses.json เดิมคัดลอกไว้ดู) ท่าอื่นอยู่ที่เดิม
function archive(cdir, out, poses, partial) {
  const name = oldName(cdir);
  if (!existsSync(out)) return { name };
  if (!partial) {
    renameSync(out, join(cdir, name));
    return { name };
  }
  const files = Object.keys(poses).flatMap((n) => [`${n}.png`, `${n}-talk.png`]).filter((f) => existsSync(join(out, f)));
  if (!files.length) return { name };
  mkdirSync(join(cdir, name), { recursive: true });
  for (const f of files) renameSync(join(out, f), join(cdir, name, f));
  if (existsSync(join(out, "poses.json"))) copyFileSync(join(out, "poses.json"), join(cdir, name, "poses.json"));
  return { name };
}

async function work({ dir, ctx, state, char, poses, replace, partial, run: fresh }) {
  const run = pinRun(state, fresh);
  const costDir = join(dir, ".vf");
  const out = posesDir(dir, char.id);
  const cdir = join(dir, "characters", char.id);

  // เก็บชุดเดิมไว้ก่อนสร้างใหม่ (ชื่อโฟลเดอร์ใช้เป็นเกลือ seed ให้ได้ภาพชุดใหม่ ไม่ชน cache)
  const archived = replace ? await step(state, "archive", async () => archive(cdir, out, poses, partial)) : undefined;

  const made = await makePoses({ dir, slug: ctx.slug, char, poses, maxRerolls: MAX_REROLLS, run, costDir, state, salt: archived ? `:${archived.name}` : "" });
  const all = await step(state, "files", async () => {
    log("ขั้น files");
    mkdirSync(out, { recursive: true });
    // รวมกับชุดเดิม: ลำดับท่าเดิมคงไว้ ท่าใหม่ต่อท้าย (รันซ้ำได้ผลเหมือนเดิม)
    const set = { ...(partial ? readSet(out) : {}), ...made.poses };
    writeJsonAtomic(join(out, "poses.json"), { character: char.id, poses: set });
    return { done: true, names: Object.keys(set) };
  });

  const warnings = Object.entries(made.poses).flatMap(([n, p]) => [
    ...(p.passed ? [] : [`${n}: ${NO_PASS_WARNING}`]),
    ...(p.talk_passed === false ? [`${n} (talk): ${NO_PASS_WARNING}`] : []),
  ]);
  return {
    character: char.id,
    poses: all.names ?? Object.keys(made.poses),
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
  const partial = replace && values.poses !== undefined;
  const poses = pickPoses(values.poses);
  const dir = resolveProject(ref);
  const ctx = loadProject(dir);
  const char = ctx.characters.find((c) => c.id === cid);
  if (!char) throw new VfError("USAGE", `ไม่พบตัวละคร "${cid}" ใน project (ดู vf project show ${ctx.slug})`);
  if (!replace && existsSync(join(posesDir(dir, cid), "poses.json"))) {
    throw new VfError("USAGE", `มีท่าแล้ว ใช้ --replace เพื่อสร้างใหม่ทั้งชุด หรือ --replace --poses <ท่า> เพื่อสร้างใหม่เฉพาะท่านั้น (ของเดิมจะถูกเก็บไว้ใน poses-old-*): ${cid}`);
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
    // partial เก็บเฉพาะเมื่อ true เพื่อให้ state เก่า (ไม่มีช่องนี้) ทำต่อได้
    pinInput(state, { poses: Object.keys(poses), replace, ...(partial ? { partial } : {}) }, ["poses", "replace", "partial"], "ของคำสั่งนี้ที่ทำค้างไว้ ให้ใช้ input เดิมเพื่อทำต่อ");
    return state;
  };
  // ใส่ --poses เฉพาะเมื่อผู้ใช้ระบุ: กับ --replace มันเปลี่ยนความหมาย (แทนบางท่า vs ทั้งชุด)
  const command = ["character", "poses", dir, cid, ...(values.poses !== undefined ? [`--poses=${Object.keys(poses).join(",")}`] : []), ...(replace ? ["--replace"] : [])];
  return await runEntity({
    dir, projectRef: ref, slug: ctx.slug, command, label: `character poses ${cid}`, foreground: values.foreground,
    work: ({ run }) => work({ dir, ctx, state: openRun(), char, poses, replace, partial, run }),
  });
}
