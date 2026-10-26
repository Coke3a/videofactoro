import fs from "node:fs";
import path from "node:path";
import { requireEnv } from "./env.mjs";
import { VfError, log } from "./out.mjs";

let fetchFn = (...a) => globalThis.fetch(...a);
let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
export const setFetch = (fn) => { fetchFn = fn; };
export const setSleep = (fn) => { sleepFn = fn; };
let nowFn = () => Date.now();
export const setNow = (fn) => { nowFn = fn; };

const BASE = "https://api.cloudflare.com/client/v4/accounts";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export const isCfHosted = (model) => model.startsWith("@cf/");

const MODERATION = [/moderation/i, /content[\s_-]*moderat/i, /moderated/i, /safety/i, /nsfw/i, /flagged/i];
const CONFIG = [/no route for that uri/i, /not found/i, /unauthoriz/i, /invalid.*(token|credential|api key)/i, /authentication/i];
const TIMEOUT = [/timed?\s*out/i, /timeout/i, /deadline/i, /abort/i];

export function classify({ status = 0, body = "" }) {
  const text = String(body ?? "");
  if (MODERATION.some((re) => re.test(text))) return "CONTENT_BLOCKED";
  if (CONFIG.some((re) => re.test(text))) return "CONFIG_ERROR";
  if (TIMEOUT.some((re) => re.test(text))) return "TIMEOUT";
  if (status === 408) return "TIMEOUT";
  if (status === 429) return "PROVIDER_BUSY";
  if ([401, 403, 404, 405].includes(status)) return "CONFIG_ERROR";
  if (status === 400 || status === 413 || status === 422) return "BAD_INPUT";
  if (status >= 500) return "PROVIDER_DOWN";
  return "PROVIDER_DOWN";
}

function scrub(text) {
  const t = process.env.CLOUDFLARE_AI_API_TOKEN;
  let s = String(text ?? "");
  if (t) s = s.split(t).join("***");
  return s.slice(0, 500);
}

function providerError(status, body) {
  const b = typeof body === "string" ? body : JSON.stringify(body);
  const e = new Error(`Cloudflare ตอบ ${status || "error"}: ${scrub(b)}`);
  e.status = status;
  e.body = scrub(b);
  return e;
}

function headers(env, opts) {
  const h = { Authorization: `Bearer ${env.CLOUDFLARE_AI_API_TOKEN}` };
  if (opts.meta && Object.keys(opts.meta).length) h["cf-aig-metadata"] = JSON.stringify(opts.meta);
  if (process.env.VF_AIG_GATEWAY_ID) h["cf-aig-gateway-id"] = process.env.VF_AIG_GATEWAY_ID;
  return h;
}

function buildForm(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) fd.append(k, new Blob([v]), k);
    else if (typeof v === "string") fd.append(k, v);
    else fd.append(k, JSON.stringify(v));
  }
  return fd;
}

const stateOf = (r) => (r && typeof r === "object" && typeof r.state === "string" ? r.state.toLowerCase() : null);
const idOf = (r) => (r && typeof r === "object" ? r.request_id ?? r.id ?? null : null);

function hasMedia(r) {
  try { extractMedia(r); return true; } catch { return false; }
}

async function call(url, init, timeoutMs) {
  let res;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = new Error(`เรียก Cloudflare ไม่สำเร็จ: ${scrub(err?.message)}`);
    e.kind = err?.name === "TimeoutError" || err?.name === "AbortError" ? "TIMEOUT" : "PROVIDER_DOWN";
    throw e;
  }
  const raw = await res.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* non-JSON body */ }
  if (!res.ok) throw providerError(res.status, raw);
  if (payload && payload.success === false) throw providerError(res.status, raw);
  const result = payload && "result" in payload ? payload.result : payload;
  return { result, raw, status: res.status };
}

function checkState(result, status, raw) {
  const s = stateOf(result);
  if (s && s !== "completed" && s !== "queued" && s !== "running") throw providerError(status, raw);
}

export async function run(model, input, opts = {}) {
  const env = requireEnv(["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN"]);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = `${BASE}/${env.CLOUDFLARE_AI_ACCOUNT_ID}/ai/run`;
  const hosted = isCfHosted(model);
  const url = hosted ? `${base}/${model}` : base;
  const h = headers(env, opts);
  let body;
  if (opts.multipart) {
    body = buildForm(hosted ? input : { model, ...input });
  } else {
    h["Content-Type"] = "application/json";
    body = JSON.stringify(hosted ? input : { model, input });
  }
  const t0 = Date.now();
  let { result, raw, status } = await call(url, { method: "POST", headers: h, body }, timeoutMs);
  checkState(result, status, raw);
  const s = stateOf(result);
  if ((s === "queued" || s === "running") && !hasMedia(result)) {
    const id = idOf(result);
    if (!id) throw providerError(status, raw);
    try {
      result = await pollRequest(id, { timeoutMs: opts.pollTimeoutMs, meta: opts.meta });
    } catch (err) {
      throw tagPollError(err, id);
    }
  } else if (s && s !== "completed") {
    throw providerError(status, raw);
  }
  return { result, ms: Date.now() - t0 };
}

// After a request id exists, errors must never trigger a resubmit (double billing).
function tagPollError(err, id) {
  const msg = scrub(err?.message);
  const kind = err?.kind ?? classify({ status: err?.status, body: err?.body ?? err?.message });
  const details = { kind, request_id: id };
  if (err instanceof VfError) return new VfError(err.code, err.message, { ...err.details, request_id: id });
  if (kind === "CONTENT_BLOCKED") return new VfError("BLOCKED", `เนื้อหาถูกบล็อก: ${msg}`, details);
  if (kind === "CONFIG_ERROR") return new VfError("CONFIG", `ตั้งค่า Cloudflare ไม่ถูกต้อง: ${msg}`, details);
  return new VfError("PROVIDER", msg, details);
}

const isTransient = (err) =>
  err?.kind === "TIMEOUT" || err?.kind === "PROVIDER_DOWN" || err?.status === 429 || err?.status >= 500;

export async function pollRequest(id, { intervalMs = 5000, timeoutMs = 18 * 60 * 1000, meta } = {}) {
  const env = requireEnv(["CLOUDFLARE_AI_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN"]);
  const url = `${BASE}/${env.CLOUDFLARE_AI_ACCOUNT_ID}/ai/requests/${id}`;
  const h = headers(env, { meta });
  const deadline = nowFn() + timeoutMs;
  for (;;) {
    try {
      const { result, raw, status } = await call(url, { method: "GET", headers: h }, 60_000);
      const s = stateOf(result);
      if (s === null || s === "completed") return result;
      if (s !== "queued" && s !== "running") throw providerError(status, raw);
    } catch (err) {
      if (!isTransient(err)) throw err;
    }
    if (nowFn() >= deadline) {
      throw new VfError("PROVIDER", "รอผลจาก Cloudflare นานเกินกำหนด (Request timed out)", { kind: "TIMEOUT", request_id: id });
    }
    await sleepFn(intervalMs);
  }
}

export function extractMedia(result) {
  for (const field of ["image", "video", "audio"]) {
    for (const holder of [result, result?.result]) {
      const v = holder?.[field];
      if (typeof v === "string" && v) {
        const m = v.match(/^data:[^;,]*;base64,(.*)$/s);
        if (m) return { kind: "base64", value: m[1], field };
        if (/^https?:\/\//i.test(v)) return { kind: "url", value: v, field };
        return { kind: "base64", value: v, field };
      }
    }
  }
  throw new VfError("PROVIDER", "ผลลัพธ์จาก Cloudflare ไม่มี image/video/audio", { kind: "NO_MEDIA" });
}

export async function download(urlOrMedia, file) {
  const media = typeof urlOrMedia === "string" ? { kind: "url", value: urlOrMedia } : urlOrMedia;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (media.kind === "base64") {
    fs.writeFileSync(file, Buffer.from(media.value, "base64"));
    return file;
  }
  let res;
  try {
    res = await fetchFn(media.value, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  } catch (err) {
    throw new VfError("PROVIDER", `ดาวน์โหลดไม่สำเร็จ: ${scrub(err?.message)}`, { kind: "PROVIDER_DOWN" });
  }
  if (!res.ok) throw new VfError("PROVIDER", `ดาวน์โหลดไม่สำเร็จ: HTTP ${res.status}`, { kind: "PROVIDER_DOWN" });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const RETRY = {
  TIMEOUT: { retries: 2, delays: [0, 0] },
  PROVIDER_BUSY: { retries: 3, delays: [10_000, 20_000, 30_000] },
  PROVIDER_DOWN: { retries: 3, delays: [10_000, 20_000, 30_000] },
};

export async function withRetry(fn) {
  const used = {};
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VfError) throw err;
      const kind = err?.kind ?? classify({ status: err?.status, body: err?.body ?? err?.message });
      const msg = scrub(err?.message);
      if (kind === "CONTENT_BLOCKED") throw new VfError("BLOCKED", `เนื้อหาถูกบล็อก: ${msg}`, { kind });
      if (kind === "CONFIG_ERROR") throw new VfError("CONFIG", `ตั้งค่า Cloudflare ไม่ถูกต้อง: ${msg}`, { kind });
      const policy = RETRY[kind];
      const n = used[kind] ?? 0;
      if (!policy || n >= policy.retries) throw new VfError("PROVIDER", msg, { kind });
      used[kind] = n + 1;
      const delay = policy.delays[n];
      log(`Cloudflare ${kind} ลองใหม่ครั้งที่ ${n + 1}/${policy.retries}`);
      if (delay) await sleepFn(delay);
    }
  }
}
