import { spawn } from "node:child_process";
import { openSync, closeSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readJson, writeJsonAtomic } from "./state.mjs";
import { VfError, redact } from "./out.mjs";

const DEFAULT_ENTRY = new URL("../bin/vf.mjs", import.meta.url).pathname;
const DEAD_MSG = "worker หยุดกลางทาง — รันคำสั่งเดิมซ้ำเพื่อทำต่อ";

const alive = (pid) => {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

export function listJobIds(jobRoot) {
  if (!existsSync(jobRoot)) return [];
  return readdirSync(jobRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(jobRoot, d.name, "job.json")))
    .map((d) => d.name)
    .sort();
}

function newId() {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${t}-${randomBytes(2).toString("hex")}`;
}

export function startJob({ jobRoot, command, label, entry = DEFAULT_ENTRY }) {
  for (const id of listJobIds(jobRoot)) {
    const j = readJson(join(jobRoot, id, "job.json"), null);
    if (j?.status === "running" && alive(j.pid)) {
      throw new VfError("USAGE", `มี job กำลังรันอยู่ใน project นี้: ${id}`);
    }
  }
  const id = newId();
  const dir = join(jobRoot, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "job.json");
  const rec = { id, command, label, status: "running", started_at: new Date().toISOString() };
  writeJsonAtomic(file, rec);
  const fd = openSync(join(dir, "job.log"), "a");
  let child;
  try {
    child = spawn(process.execPath, [entry, ...command, "--foreground", "--job-dir", dir], {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  child.unref();
  const cur = readJson(file, rec);
  if (cur.status === "running") writeJsonAtomic(file, { ...cur, pid: child.pid });
  return { id, dir, status: "running", pid: child.pid };
}

export function finishJob(dir, outcome) {
  const file = join(dir, "job.json");
  const cur = readJson(file, {});
  const next = {
    ...cur,
    status: outcome.error ? "failed" : "done",
    ...(outcome.error ? { error: outcome.error } : { result: outcome.result }),
    finished_at: new Date().toISOString(),
  };
  writeJsonAtomic(file, JSON.parse(redact(JSON.stringify(next))));
}

export function jobStatus(dir) {
  const j = readJson(join(dir, "job.json"));
  let log_tail = [];
  try {
    log_tail = readFileSync(join(dir, "job.log"), "utf8").split("\n").filter(Boolean).slice(-20);
  } catch {}
  log_tail = log_tail.map(redact);
  const out = { id: j.id, status: j.status, log_tail };
  if (j.result !== undefined) out.result = j.result;
  if (j.error !== undefined) out.error = j.error;
  if (j.status === "running" && !alive(j.pid)) {
    out.status = "failed";
    out.error = DEAD_MSG;
  }
  return out;
}

export async function waitJob(dir, timeoutSec = 540, pollMs = 2000) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const s = jobStatus(dir);
    if (s.status !== "running" || Date.now() >= deadline) return s;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}
