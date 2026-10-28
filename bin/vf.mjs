#!/usr/bin/env node
import { loadEnv } from "../tools/env.mjs";
import { emit, fail, VfError, EXIT } from "../tools/out.mjs";
import { finishJob, setWorkerJob, startHeartbeat } from "../tools/jobs.mjs";

const COMMANDS = {
  setup: "setup",
  doctor: "doctor",
  "project create": "project-create",
  "project show": "project-show",
  "character add": "character-add",
  "character poses": "character-poses",
  "place add": "place-add",
  "asset find": "asset-find",
  "music list": "music-list",
  "music add": "music-add",
  clip: "clip",
  film: "film",
  motion: "motion",
  wait: "wait",
  status: "status",
  help: null,
};

function takeJobDir(argv) {
  const out = [];
  let jobDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--job-dir") jobDir = argv[++i] ?? "";
    else if (argv[i].startsWith("--job-dir=")) jobDir = argv[i].slice(10);
    else out.push(argv[i]);
  }
  if (jobDir !== undefined && (jobDir === "" || jobDir.startsWith("--"))) {
    return { argv: out, jobDir: undefined, bad: true };
  }
  return { argv: out, jobDir };
}

async function run(argv) {
  loadEnv();
  const two = argv.slice(0, 2).join(" ");
  const one = argv[0] ?? "help";
  let cmd, rest;
  if (Object.hasOwn(COMMANDS, two)) [cmd, rest] = [two, argv.slice(2)];
  else if (Object.hasOwn(COMMANDS, one)) [cmd, rest] = [one, argv.slice(1)];
  else {
    throw new VfError("USAGE", `ไม่รู้จักคำสั่ง: ${argv.slice(0, 2).join(" ")}`, {
      commands: Object.keys(COMMANDS),
    });
  }
  if (cmd === "help") return { commands: Object.keys(COMMANDS) };
  const file = new URL(`../tools/${COMMANDS[cmd]}.mjs`, import.meta.url);
  const mod = await import(file.href);
  return await mod.main(rest);
}

const { argv: args, jobDir, bad } = takeJobDir(process.argv.slice(2));
if (jobDir) {
  setWorkerJob(jobDir);
  startHeartbeat(jobDir);
}
const safeFinish = (outcome) => {
  if (!jobDir) return;
  try {
    finishJob(jobDir, outcome);
  } catch {}
};
let result;
let failure = bad ? new VfError("USAGE", "--job-dir ต้องมีค่าเป็นโฟลเดอร์") : undefined;
if (!failure) {
  try {
    result = await run(args);
  } catch (e) {
    failure = e;
  }
}
if (!failure) {
  safeFinish({ result });
  emit(result);
} else {
  const v = failure instanceof VfError ? failure : new VfError("INTERNAL", failure?.message ?? String(failure));
  const code = v.code in EXIT ? v.code : "INTERNAL";
  safeFinish({ error: { code, message: v.message, details: v.details } });
  fail(failure);
}
