import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./out.mjs";
import { llmJson } from "./llm.mjs";
import { localChecks, assertCore, attempt, cfTokenCheck } from "./doctor.mjs";

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

export async function main(argv, { costDir = join(REPO_ROOT, ".vf-setup") } = {}) {
  parse(argv, {});
  const checks = localChecks();
  assertCore(checks);
  checks.push(await cfTokenCheck());
  checks.push(await creditsCheck(costDir));
  return { checks };
}
