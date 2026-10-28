import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./out.mjs";
import { llmJson } from "./llm.mjs";
import { localChecks, hfChecks, assertCore, attempt, cfTokenCheck } from "./doctor.mjs";
import { HF_ENV } from "./hf.mjs";

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

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, ...HF_ENV } });
  if (r.error || r.status !== 0) throw new Error(`${cmd} ${args[0]} ล้มเหลว: ${(r.stderr || r.error?.message || "").trim()}`);
};

// ติดตั้งเฉพาะตอนยังไม่มี binary; browser ensure รันเสมอ (ล้มเหลว = รายงาน ไม่ crash)
export const hfInstallChecks = async () => {
  const bin = join(REPO_ROOT, "node_modules", ".bin", "hyperframes");
  const out = [];
  if (!existsSync(bin)) out.push(await attempt("hf:install", () => (sh("npm", ["ci", "--omit=dev"]), "npm ci แล้ว")));
  else out.push({ name: "hf:install", ok: true, detail: "ติดตั้งแล้ว" });
  if (out[0].ok) out.push(await attempt("hf:browser", () => (sh(bin, ["browser", "ensure"]), "Chrome พร้อม")));
  return out;
};

export async function main(argv, { costDir = join(REPO_ROOT, ".vf-setup"), hfInstall = hfInstallChecks } = {}) {
  parse(argv, {});
  let checks = localChecks();
  assertCore(checks);
  const inst = await hfInstall();
  // ตรวจ hyperframes/gsap ใหม่หลังติดตั้ง
  checks = [...checks.filter((c) => c.name !== "hyperframes" && c.name !== "gsap"), ...inst, ...hfChecks()];
  checks.push(await cfTokenCheck());
  checks.push(await creditsCheck(costDir));
  return { checks };
}
