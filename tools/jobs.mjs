import { spawn } from "node:child_process";
import { openSync, closeSync, mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync, statSync, rmSync, renameSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readJson, writeJsonAtomic } from "./state.mjs";
import { VfError, redact } from "./out.mjs";

const DEFAULT_ENTRY = new URL("../bin/vf.mjs", import.meta.url).pathname;
const NO_PID_GRACE_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_STALE_MS = 120_000;
const LOCK_STALE_MS = 30_000;
const DEAD_MSG = "worker หยุดกลางทาง — รันคำสั่งเดิมซ้ำเพื่อทำต่อ";

let nowFn = () => Date.now();
export const setNow = (fn) => {
  nowFn = fn;
};

export const shq = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
export const resumeCommand = (command) => `vf ${command.map(shq).join(" ")}`;

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

function readPid(dir) {
  try {
    const n = Number(readFileSync(join(dir, "job.pid"), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function heartbeatAt(dir) {
  try {
    return statSync(join(dir, "heartbeat")).mtimeMs;
  } catch {
    return null;
  }
}

// ตาย = pid ตาย หรือ heartbeat (ถ้าไม่มี ใช้ started_at) เก่ากว่า 120 วิ และไม่ใช่โปรเซสนี้เอง
function isAlive(dir, j) {
  const now = nowFn();
  const started = Date.parse(j.started_at);
  const pid = readPid(dir);
  if (pid === null) return now - started <= NO_PID_GRACE_MS;
  if (!pidAlive(pid)) return false;
  if (pid === process.pid) return true;
  const beat = heartbeatAt(dir) ?? started;
  return now - beat <= HEARTBEAT_STALE_MS;
}

// แตะ <dir>/heartbeat ทันทีและทุก 30 วิ (interval แบบ unref ไม่ค้าง process) · คืนฟังก์ชันหยุด
export function startHeartbeat(dir) {
  const file = join(dir, "heartbeat");
  const touch = () => {
    try {
      const t = new Date();
      if (existsSync(file)) utimesSync(file, t, t);
      else if (existsSync(dir)) writeFileSync(file, "");
    } catch {}
  };
  touch();
  const timer = setInterval(touch, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function jobRootOf(project) {
  if (!project) throw new VfError("USAGE", "ต้องระบุ <project>");
  const root = join(project, ".jobs");
  if (!existsSync(root)) throw new VfError("USAGE", `ไม่พบโฟลเดอร์ .jobs ใน: ${project}`);
  return root;
}

export function listJobIds(jobRoot) {
  if (!existsSync(jobRoot)) return [];
  return readdirSync(jobRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(jobRoot, d.name, "job.json")))
    .map((d) => d.name)
    .sort();
}

function newId() {
  const t = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 18);
  return `${t}-${randomBytes(2).toString("hex")}`;
}

const BUSY = "มี job กำลังรันอยู่ใน project นี้";

function takeLock(jobRoot) {
  mkdirSync(jobRoot, { recursive: true });
  const lock = join(jobRoot, ".lock");
  for (let attempt = 0; ; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      return lock;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch {}
      if (attempt === 0 && stale) {
        rmSync(lock, { force: true });
        continue;
      }
      throw new VfError("USAGE", BUSY);
    }
  }
}

// ลงทะเบียน job ภายใต้ lock ของ project: ถ้ามี job อื่นกำลังรัน → USAGE (ใช้ร่วมกันทั้ง worker และ foreground)
export function registerJob({ jobRoot, command, label, pid }) {
  const lock = takeLock(jobRoot);
  try {
    for (const id of listJobIds(jobRoot)) {
      let j;
      try {
        j = readJson(join(jobRoot, id, "job.json"), null);
      } catch {
        continue;
      }
      if (j?.status === "running" && isAlive(join(jobRoot, id), j)) {
        throw new VfError("USAGE", `${BUSY}: ${id}`);
      }
    }
    const id = newId();
    const dir = join(jobRoot, id);
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(join(dir, "job.json"), {
      id,
      command,
      label,
      status: "running",
      started_at: new Date().toISOString(),
    });
    if (pid) writeFileSync(join(dir, "job.pid"), String(pid));
    return { id, dir };
  } finally {
    rmSync(lock, { force: true });
  }
}

let workerJobDir = null;
export const setWorkerJob = (dir) => {
  workerJobDir = dir || null;
};
export const isWorker = () => workerJobDir !== null;

export function startJob({ jobRoot, command, label, entry = DEFAULT_ENTRY, execPath = process.execPath }) {
  const { id, dir } = registerJob({ jobRoot, command, label });
  let failed = null;
  const fail = (e) => {
    if (failed) return failed;
    const error = { code: "INTERNAL", message: `เริ่ม worker ไม่สำเร็จ: ${e?.message ?? e}` };
    try {
      finishJob(dir, { error });
    } catch {}
    return (failed = new VfError("INTERNAL", error.message));
  };
  const fd = openSync(join(dir, "job.log"), "a");
  let child;
  try {
    child = spawn(execPath, [entry, ...command, "--foreground", "--job-dir", dir], {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } catch (e) {
    throw fail(e);
  } finally {
    closeSync(fd);
  }
  child.on("error", fail);
  child.unref();
  if (!child.pid) throw fail(new Error("ไม่มี pid"));
  writeFileSync(join(dir, "job.pid"), String(child.pid));
  return { id, dir, status: "running", pid: child.pid };
}

// ไม่สร้างโฟลเดอร์ job: ถ้าโฟลเดอร์หายไปแล้ว (เช่น ถูกลบ) ข้ามเงียบๆ
export function finishJob(dir, outcome) {
  const file = join(dir, "job.json");
  if (!existsSync(dir)) return;
  const cur = readJson(file, {});
  const next = {
    ...cur,
    status: outcome.error ? "failed" : "done",
    ...(outcome.error ? { error: outcome.error } : { result: outcome.result }),
    finished_at: new Date().toISOString(),
  };
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(JSON.parse(redact(JSON.stringify(next))), null, 2) + "\n");
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    if (e.code !== "ENOENT") throw e;
  }
}

export function jobStatus(dir) {
  const j = readJson(join(dir, "job.json"));
  let log_tail = [];
  try {
    log_tail = readFileSync(join(dir, "job.log"), "utf8").split("\n").filter(Boolean).slice(-20);
  } catch {}
  log_tail = log_tail.map(redact);
  const out = { id: j.id, status: j.status, command: j.command, label: j.label, log_tail };
  if (j.result !== undefined) out.result = j.result;
  if (j.error !== undefined) out.error = j.error;
  if (j.status === "running" && !isAlive(dir, j)) {
    out.status = "failed";
    out.error = { code: "INTERNAL", message: DEAD_MSG };
  }
  if (out.status === "failed" && Array.isArray(j.command)) out.resume = resumeCommand(j.command);
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
