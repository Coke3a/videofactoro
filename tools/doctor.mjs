import { spawnSync } from "node:child_process";
import { VfError, parse, redact } from "./out.mjs";
import { getFetch } from "./cf.mjs";
import { presignUrl, r2Config } from "./r2.mjs";

export const CORE = ["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN"];
// R2 is only needed for video keyframes (flux-3-video takes URLs); images send refs inline.
const OPTIONAL = ["VF_R2_BUCKET", "VF_R2_TOKEN", "VF_R2_ACCESS_KEY_ID", "VF_R2_SECRET_ACCESS_KEY", "VF_AIG_GATEWAY_ID"];

const isSet = (n) => Boolean(process.env[n]);
export const hasR2Credential = () =>
  isSet("VF_R2_TOKEN") || (isSet("VF_R2_ACCESS_KEY_ID") && isSet("VF_R2_SECRET_ACCESS_KEY"));
export const hasR2 = () => isSet("VF_R2_BUCKET") && hasR2Credential();
export const R2_SKIP = "ข้าม (ยังไม่ตั้ง R2 — ต้องใช้ตอนทำวิดีโอเท่านั้น)";

function envCheck(name, required) {
  const v = process.env[name];
  if (v) return { name: `env:${name}`, ok: true, detail: `ตั้งแล้ว ยาว ${v.length}` };
  return { name: `env:${name}`, ok: !required, detail: "ยังไม่ตั้ง" };
}

function binaryCheck(bin) {
  const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return { name: bin, ok: false, detail: `ไม่พบ ${bin} ใน PATH` };
  const m = /version\s+(\S+)/.exec(r.stdout ?? "");
  return { name: bin, ok: true, detail: m ? m[1] : "พบแล้ว" };
}

export function localChecks() {
  const major = Number(process.versions.node.split(".")[0]);
  return [
    { name: "node>=22", ok: major >= 22, detail: process.versions.node },
    binaryCheck("ffmpeg"),
    binaryCheck("ffprobe"),
    ...CORE.map((n) => envCheck(n, true)),
    ...OPTIONAL.map((n) => envCheck(n, false)),
    hasR2Credential()
      ? { name: "env:R2_CREDENTIAL", ok: true, detail: isSet("VF_R2_TOKEN") ? "VF_R2_TOKEN" : "access key pair" }
      : { name: "env:R2_CREDENTIAL", ok: true, detail: "ยังไม่ตั้ง (ต้องใช้ตอนทำวิดีโอเท่านั้น)" },
  ];
}

export function assertCore(checks) {
  const missing = CORE.filter((n) => !isSet(n));
  if (missing.length) {
    throw new VfError("CONFIG", `ยังไม่ได้ตั้ง: ${missing.join(", ")} — รัน tools/set-env.sh แล้วลองใหม่`, { checks });
  }
}

export async function attempt(name, fn) {
  try {
    const detail = await fn();
    return { name, ok: true, detail: detail ?? "ok" };
  } catch (err) {
    return { name, ok: false, detail: redact(err?.message ?? String(err)).slice(0, 300) };
  }
}

export const cfTokenCheck = () =>
  attempt("cf:token", async () => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_AI_ACCOUNT_ID}/ai/models/search?per_page=1`;
    let res;
    try {
      res = await getFetch()(url, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_AI_API_TOKEN}` } });
    } catch {
      throw new Error("เรียก api.cloudflare.com ไม่ได้");
    }
    if (!res.ok) throw new Error(`token ใช้ไม่ได้หรือ account id ผิด (HTTP ${res.status})`);
    return `HTTP ${res.status}`;
  });

export const r2BucketCheck = () =>
  attempt("r2:bucket", async () => {
    const cfg = await r2Config();
    const url = presignUrl({
      method: "HEAD", host: cfg.host, path: `/${cfg.bucket}`, region: "auto",
      accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, expiresSec: 60, now: new Date(),
    });
    let res;
    try {
      res = await getFetch()(url, { method: "HEAD" });
    } catch {
      throw new Error("เรียก R2 ไม่ได้");
    }
    if (res.status === 404) throw new Error("ไม่พบ bucket (vf setup จะสร้างให้)");
    if (res.status === 401 || res.status === 403) throw new Error(`R2 ปฏิเสธสิทธิ์ (HTTP ${res.status})`);
    if (!res.ok) throw new Error(`R2 ตอบ HTTP ${res.status}`);
    return "มี bucket";
  });

export async function main(argv) {
  const { values } = parse(argv, { online: { type: "boolean" } });
  const checks = localChecks();
  assertCore(checks);
  if (values.online) {
    checks.push(await cfTokenCheck(), hasR2() ? await r2BucketCheck() : { name: "r2:bucket", ok: true, detail: R2_SKIP });
  }
  return { checks };
}
