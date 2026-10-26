// Spike b: does VF_R2_TOKEN converted to an S3 key (access key id = token id, secret = sha256(token)) work?
// Spend: none (one tokens/verify call, one HEAD bucket, one PUT of 16 bytes, one GET; object expires via lifecycle).
// Run with ONLY VF_R2_TOKEN set for R2 (unset VF_R2_ACCESS_KEY_ID / VF_R2_SECRET_ACCESS_KEY first): node spikes/b-r2-token.mjs
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { r2Config, headObject, uploadTemp } from "../tools/r2.mjs";
import { getFetch } from "../tools/cf.mjs";
import { out, facts } from "./_lib.mjs";

const result = { using: process.env.VF_R2_ACCESS_KEY_ID ? "access-key-pair (token path NOT tested)" : "VF_R2_TOKEN" };
const step = async (name, fn) => {
  try { result[name] = { ok: true, value: await fn() }; } catch (e) { result[name] = { ok: false, error: String(e.message).slice(0, 300), code: e.code }; }
};

await step("config", async () => { const c = await r2Config(); return { host: c.host, bucket: c.bucket, key_id_length: c.accessKeyId.length }; });
await step("head_missing_object", () => headObject("tmp/spike-b-does-not-exist"));
await step("upload_and_get", async () => {
  const f = out("b-probe.bin");
  const bytes = randomBytes(16);
  fs.writeFileSync(f, bytes);
  const url = await uploadTemp(f);
  const res = await getFetch()(url);
  return { status: res.status, equal: Buffer.from(await res.arrayBuffer()).equals(bytes) };
});
result.conclusion = result.upload_and_get?.ok && result.upload_and_get.value.equal ? "token conversion works" : "token conversion FAILED - set VF_R2_ACCESS_KEY_ID/SECRET";
facts("b-r2-token", result);
