import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openState, step, writeJsonAtomic } from "../tools/state.mjs";
import { startJob, jobStatus, waitJob } from "../tools/jobs.mjs";

const VF = new URL("../bin/vf.mjs", import.meta.url).pathname;
const kill = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};

process.env.VF_NO_DOTENV = "1";
const FAKE = new URL("./fixtures/fake-cmd.mjs", import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), "vf-jobs-"));

test("step ข้ามขั้นที่ done แล้ว", async () => {
  const d = tmp();
  try {
    let n = 0;
    const fn = async () => (++n, { v: 42 });
    assert.deepEqual(await step(openState(d), "a", fn), { v: 42 });
    assert.deepEqual(await step(openState(d), "a", fn), { v: 42 });
    assert.equal(n, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("step ที่ล้มบันทึก failed และ attempts", async () => {
  const d = tmp();
  try {
    const boom = async () => {
      throw new Error("พัง");
    };
    await assert.rejects(step(openState(d), "a", boom), /พัง/);
    await assert.rejects(step(openState(d), "a", boom), /พัง/);
    const s = openState(d).get("a");
    assert.equal(s.status, "failed");
    assert.equal(s.attempts, 2);
    assert.equal(s.error, "พัง");
    assert.ok(s.updated_at);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("startJob รันจนเสร็จและ waitJob ได้ done", async () => {
  const root = join(tmp(), ".jobs");
  try {
    const job = startJob({ jobRoot: root, command: ["fake"], label: "t", entry: FAKE });
    assert.equal(job.status, "running");
    const r = await waitJob(job.dir, 20, 100);
    assert.equal(r.status, "done");
    assert.equal(r.result.x, 1);
    assert.equal(r.id, job.id);
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("startJob ตัวที่สองบน jobRoot เดียวกันระหว่างตัวแรกยังรัน ได้ USAGE", async () => {
  const root = join(tmp(), ".jobs");
  let job;
  try {
    job = startJob({ jobRoot: root, command: ["fake", "--sleep", "3"], label: "t", entry: FAKE });
    assert.throws(
      () => startJob({ jobRoot: root, command: ["fake"], label: "t2", entry: FAKE }),
      (e) => e.code === "USAGE" && e.message.includes(job.id),
    );
  } finally {
    if (job) kill(job.pid);
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("lock สดค้างอยู่ -> USAGE; job.json เสียถูกข้าม", () => {
  const root = join(tmp(), ".jobs");
  try {
    mkdirSync(join(root, "bad"), { recursive: true });
    writeFileSync(join(root, "bad", "job.json"), "{not json");
    writeFileSync(join(root, ".lock"), "");
    assert.throws(
      () => startJob({ jobRoot: root, command: ["fake"], label: "t", entry: FAKE }),
      (e) => e.code === "USAGE" && /มี job กำลังรันอยู่/.test(e.message),
    );
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("job id เรียงตามเวลาได้ ระดับ ms", () => {
  const root = join(tmp(), ".jobs");
  const ids = [];
  try {
    for (let i = 0; i < 2; i++) {
      const j = startJob({ jobRoot: root, command: ["fake"], label: "t", entry: FAKE });
      ids.push(j.id);
      kill(j.pid);
      writeJsonAtomic(join(j.dir, "job.json"), { id: j.id, status: "done" });
    }
    assert.match(ids[0], /^\d{8}-\d{9}-[0-9a-f]{4}$/);
    assert.ok(ids[0] < ids[1]);
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("spawn ล้มเหลว -> job เป็น failed และ throw", () => {
  const root = join(tmp(), ".jobs");
  try {
    assert.throws(() => startJob({ jobRoot: root, command: ["fake"], label: "t", entry: FAKE, execPath: "/nonexistent/node" }));
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("job running ไม่มี pid และ started_at เก่า -> failed", () => {
  const d = tmp();
  try {
    writeJsonAtomic(join(d, "job.json"), { id: "j", status: "running", started_at: new Date(Date.now() - 60000).toISOString() });
    const s = jobStatus(d);
    assert.equal(s.status, "failed");
    assert.equal(s.error.code, "INTERNAL");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("worker จริง: --job-dir เขียน job.json failed พร้อม error.code", () => {
  const d = tmp();
  try {
    writeJsonAtomic(join(d, "job.json"), { id: "j", status: "running" });
    const r = spawnSync(process.execPath, [VF, "wait", "/nonexistent", "--job-dir", d], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).error.code, "USAGE");
    const j = JSON.parse(readFileSync(join(d, "job.json"), "utf8"));
    assert.equal(j.status, "failed");
    assert.equal(j.error.code, "USAGE");
    const bad = spawnSync(process.execPath, [VF, "help", "--job-dir", "--foreground"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("step เก็บ error แบบ redact และล้าง error เก่าเมื่อรันใหม่", async () => {
  const d = tmp();
  process.env.CLOUDFLARE_AI_API_TOKEN = "sekrit-token-value";
  try {
    await assert.rejects(step(openState(d), "a", async () => { throw new Error("bad sekrit-token-value"); }));
    assert.ok(!openState(d).get("a").error.includes("sekrit-token-value"));
    await step(openState(d), "a", async () => 1);
    assert.equal(openState(d).get("a").error, undefined);
  } finally {
    delete process.env.CLOUDFLARE_AI_API_TOKEN;
    rmSync(d, { recursive: true, force: true });
  }
});

test("jobStatus ของ pid ที่ตายแล้วเป็น failed พร้อมข้อความให้รันซ้ำ", () => {
  const d = tmp();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeJsonAtomic(join(d, "job.json"), { id: "j", status: "running", command: [], started_at: new Date().toISOString() });
    writeFileSync(join(d, "job.pid"), String(dead));
    const s = jobStatus(d);
    assert.equal(s.status, "failed");
    assert.equal(s.error.code, "INTERNAL");
    assert.match(s.error.message, /worker หยุดกลางทาง/);
    assert.deepEqual(s.log_tail, []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
