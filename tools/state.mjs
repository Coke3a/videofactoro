import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { redact } from "./out.mjs";

export function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" && fallback !== undefined) return fallback;
    throw e;
  }
}

export function openState(dir) {
  const file = join(dir, "state.json");
  const load = () => readJson(file, {});
  return {
    get: (id) => load()[id],
    set(id, patch) {
      const all = load();
      all[id] = { ...all[id], ...patch, updated_at: new Date().toISOString() };
      writeJsonAtomic(file, all);
      return all[id];
    },
    all: load,
  };
}

export async function step(state, id, fn) {
  const cur = state.get(id);
  if (cur?.status === "done") return cur.output;
  const attempts = (cur?.attempts ?? 0) + 1;
  state.set(id, { status: "running", attempts, error: undefined });
  try {
    const output = await fn();
    state.set(id, { status: "done", output, error: undefined });
    return output;
  } catch (e) {
    state.set(id, { status: "failed", error: redact(e?.message ?? e) });
    throw e;
  }
}
