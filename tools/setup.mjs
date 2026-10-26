import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./out.mjs";
import { getFetch } from "./cf.mjs";
import { ensureBucket, putLifecycle, uploadTemp } from "./r2.mjs";
import { llmJson } from "./llm.mjs";
import { localChecks, assertCore, attempt, cfTokenCheck, hasR2, R2_SKIP } from "./doctor.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const creditsCheck = (costDir) =>
  attempt("cf:credits", async () => {
    const { model } = await llmJson({
      system: "Reply with JSON only.",
      user: 'Return {"ok":true}.',
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      maxTokens: 64,
      meta: { step: "setup", item: null },
      costDir,
    });
    return `LLM ตอบได้ (${model})`;
  });

const bucketCheck = () =>
  attempt("r2:bucket", async () => {
    const state = await ensureBucket();
    await putLifecycle({ prefix: "tmp/", days: 1 });
    return `${state === "created" ? "สร้าง bucket แล้ว" : "มี bucket อยู่แล้ว"} + lifecycle tmp/ 1 วัน`;
  });

const presignCheck = () =>
  attempt("r2:presign", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-setup-"));
    try {
      const bytes = randomBytes(16);
      const file = join(dir, "probe.bin");
      writeFileSync(file, bytes);
      const url = await uploadTemp(file, { expiresSec: 300 });
      let res;
      try {
        res = await getFetch()(url);
      } catch {
        throw new Error("GET presigned URL ไม่ได้ (เชื่อมต่อไม่ได้)");
      }
      if (!res.ok) throw new Error(`GET presigned URL ล้มเหลว (HTTP ${res.status})`);
      if (!Buffer.from(await res.arrayBuffer()).equals(bytes)) throw new Error("ไฟล์ที่ได้กลับมาไม่ตรงกับที่อัปโหลด");
      return "อัปโหลด 16 ไบต์และ GET กลับมาตรงกัน";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

export async function main(argv, { costDir = join(REPO_ROOT, ".vf-setup") } = {}) {
  parse(argv, {});
  const checks = localChecks();
  assertCore(checks);
  checks.push(await cfTokenCheck());
  if (hasR2()) {
    const bucket = await bucketCheck();
    checks.push(bucket);
    checks.push(bucket.ok ? await presignCheck() : { name: "r2:presign", ok: false, detail: "ข้าม (r2:bucket ไม่ผ่าน)" });
  } else {
    checks.push({ name: "r2:bucket", ok: true, detail: R2_SKIP }, { name: "r2:presign", ok: true, detail: R2_SKIP });
  }
  checks.push(await creditsCheck(costDir));
  return { checks };
}
