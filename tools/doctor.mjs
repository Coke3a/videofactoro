import { spawnSync } from "node:child_process";
import { VfError, parse, redact } from "./out.mjs";
import { getFetch } from "./cf.mjs";

export const CORE = ["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN"];
const OPTIONAL = ["VF_AIG_GATEWAY_ID"];

const isSet = (n) => Boolean(process.env[n]);

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

export async function main(argv) {
  const { values } = parse(argv, { online: { type: "boolean" } });
  const checks = localChecks();
  assertCore(checks);
  if (values.online) checks.push(await cfTokenCheck());
  return { checks };
}
