#!/usr/bin/env node
import { existsSync } from "node:fs";
import { loadEnv } from "../tools/env.mjs";
import { emit, fail, VfError } from "../tools/out.mjs";

const COMMANDS = {
  setup: "setup",
  doctor: "doctor",
  "project create": "project-create",
  "project show": "project-show",
  "character add": "character-add",
  "place add": "place-add",
  "asset find": "asset-find",
  wait: "wait",
  status: "status",
  help: null,
};

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
  if (!existsSync(file)) throw new VfError("USAGE", `ยังไม่มีคำสั่งนี้: ${cmd}`);
  const mod = await import(file.href);
  return await mod.main(rest);
}

try {
  emit(await run(process.argv.slice(2)));
} catch (e) {
  fail(e);
}
