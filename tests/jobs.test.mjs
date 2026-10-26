import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openState, step, writeJsonAtomic } from "../tools/state.mjs";
import { startJob, jobStatus, waitJob } from "../tools/jobs.mjs";

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
  try {
    const job = startJob({ jobRoot: root, command: ["fake"], label: "t", entry: FAKE });
    assert.throws(
      () => startJob({ jobRoot: root, command: ["fake"], label: "t2", entry: FAKE }),
      (e) => e.code === "USAGE" && e.message.includes(job.id),
    );
    await waitJob(job.dir, 20, 100);
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("jobStatus ของ pid ที่ตายแล้วเป็น failed พร้อมข้อความให้รันซ้ำ", () => {
  const d = tmp();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeJsonAtomic(join(d, "job.json"), { id: "j", pid: dead, status: "running", command: [] });
    const s = jobStatus(d);
    assert.equal(s.status, "failed");
    assert.match(s.error, /worker หยุดกลางทาง/);
    assert.deepEqual(s.log_tail, []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
