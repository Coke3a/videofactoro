import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requireEnv } from "./env.mjs";
import { VfError, log } from "./out.mjs";
import { getFetch } from "./cf.mjs";

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split("/").map(enc).join("/");

export function presignUrl({ method, host, path: reqPath, region, accessKeyId, secretAccessKey, expiresSec, now, headers = {}, query = {} }) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const date = stamp.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const hdrs = { host, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])) };
  const names = Object.keys(hdrs).sort();
  const signedHeaders = names.join(";");
  const params = {
    ...query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(expiresSec),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(params)
    .map((k) => [enc(k), enc(params[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalPath = encPath(reqPath);
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    names.map((n) => `${n}:${hdrs[n]}\n`).join(""),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, date), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
  return `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export async function r2Config() {
  const env = requireEnv(["CLOUDFLARE_AI_ACCOUNT_ID", "VF_R2_BUCKET"]);
  const accountId = env.CLOUDFLARE_AI_ACCOUNT_ID;
  const base = { accountId, bucket: env.VF_R2_BUCKET, host: `${accountId}.r2.cloudflarestorage.com` };
  if (process.env.VF_R2_ACCESS_KEY_ID && process.env.VF_R2_SECRET_ACCESS_KEY) {
    return { ...base, accessKeyId: process.env.VF_R2_ACCESS_KEY_ID, secretAccessKey: process.env.VF_R2_SECRET_ACCESS_KEY };
  }
  const token = process.env.VF_R2_TOKEN;
  if (!token) throw new VfError("CONFIG", "ยังไม่ได้ตั้ง: VF_R2_ACCESS_KEY_ID+VF_R2_SECRET_ACCESS_KEY หรือ VF_R2_TOKEN");
  let res;
  try {
    res = await getFetch()("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new VfError("PROVIDER", "ตรวจสอบ VF_R2_TOKEN ไม่สำเร็จ (เรียก Cloudflare ไม่ได้)");
  }
  let id;
  try { id = (await res.json())?.result?.id; } catch { /* handled below */ }
  if (!res.ok || !id) throw new VfError("CONFIG", `VF_R2_TOKEN ใช้ไม่ได้ (HTTP ${res.status})`);
  return { ...base, accessKeyId: id, secretAccessKey: sha256hex(token) };
}

async function send(cfg, method, objPath, { key, body, headers = {}, query = {}, what }) {
  const url = presignUrl({
    method, host: cfg.host, path: objPath, region: "auto",
    accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
    expiresSec: 60, now: new Date(), headers, query,
  });
  try {
    return await getFetch()(url, { method, headers, body });
  } catch {
    throw new VfError("PROVIDER", `R2 ${what}${key ? ` ${key}` : ""} ไม่สำเร็จ (เชื่อมต่อไม่ได้)`);
  }
}

function checkStatus(res, what, key) {
  if (res.status === 401 || res.status === 403) throw new VfError("CONFIG", `R2 ปฏิเสธสิทธิ์ (${what}${key ? ` ${key}` : ""}, HTTP ${res.status})`);
  if (!res.ok) throw new VfError("PROVIDER", `R2 ${what}${key ? ` ${key}` : ""} ล้มเหลว (HTTP ${res.status})`);
}

const NOT_READY = "bucket ยังไม่พร้อม — รัน vf setup";

// งานกับไฟล์ใน bucket: 403 หรือ 404 NoSuchBucket = bucket ยังไม่ได้ตั้ง → CONFIG ให้ผู้ใช้รัน vf setup
async function checkObjectStatus(res, what, key) {
  if (res.status === 403) throw new VfError("CONFIG", `${NOT_READY} (R2 ${what} ${key}, HTTP 403)`);
  if (res.status === 404) {
    let body = "";
    try { body = await res.text(); } catch { /* no body */ }
    if (/NoSuchBucket/.test(body)) throw new VfError("CONFIG", `${NOT_READY} (R2 ${what} ${key}, NoSuchBucket)`);
  }
  checkStatus(res, what, key);
}

export async function putObject(key, bytes, contentType) {
  const cfg = await r2Config();
  const res = await send(cfg, "PUT", `/${cfg.bucket}/${key}`, { key, body: bytes, headers: { "content-type": contentType }, what: "อัปโหลด" });
  await checkObjectStatus(res, "อัปโหลด", key);
}

export async function headObject(key) {
  const cfg = await r2Config();
  const res = await send(cfg, "HEAD", `/${cfg.bucket}/${key}`, { key, what: "ตรวจสอบไฟล์" });
  if (res.status === 404) return false;
  await checkObjectStatus(res, "ตรวจสอบไฟล์", key);
  return true;
}

export async function uploadTemp(file, { expiresSec = 7200 } = {}) {
  const bytes = fs.readFileSync(file);
  const ext = path.extname(file).replace(/^\./, "").toLowerCase();
  const key = `tmp/${sha256hex(bytes)}${ext ? "." + ext : ""}`;
  if (await headObject(key)) {
    log(`R2 มี ${key} อยู่แล้ว ข้ามการอัปโหลด`);
  } else {
    const type = { mp4: "video/mp4", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp3: "audio/mpeg", wav: "audio/wav" }[ext] ?? "application/octet-stream";
    await putObject(key, bytes, type);
    log(`R2 อัปโหลด ${key}`);
  }
  const cfg = await r2Config();
  return presignUrl({
    method: "GET", host: cfg.host, path: `/${cfg.bucket}/${key}`, region: "auto",
    accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, expiresSec, now: new Date(),
  });
}

export async function ensureBucket() {
  const cfg = await r2Config();
  const p = `/${cfg.bucket}`;
  const head = await send(cfg, "HEAD", p, { what: "ตรวจสอบ bucket" });
  if (head.status === 200) return "exists";
  if (head.status === 403) throw new VfError("CONFIG", "R2 ปฏิเสธสิทธิ์ตรวจสอบ bucket (HTTP 403) — ตรวจ VF_R2_* และสิทธิ์ของ token");
  if (head.status !== 404) checkStatus(head, "ตรวจสอบ bucket");
  const put = await send(cfg, "PUT", p, { what: "สร้าง bucket" });
  checkStatus(put, "สร้าง bucket");
  return "created";
}

export async function putLifecycle({ prefix = "tmp/", days = 1 } = {}) {
  const cfg = await r2Config();
  const xml = `<LifecycleConfiguration><Rule><ID>vf-expire-${days}d</ID><Filter><Prefix>${prefix}</Prefix></Filter><Status>Enabled</Status><Expiration><Days>${days}</Days></Expiration></Rule></LifecycleConfiguration>`;
  const body = Buffer.from(xml);
  const md5 = crypto.createHash("md5").update(body).digest("base64");
  const headers = { "content-md5": md5, "content-type": "application/xml" };
  const res = await send(cfg, "PUT", `/${cfg.bucket}`, { body, headers, query: { lifecycle: "" }, what: "ตั้ง lifecycle" });
  checkStatus(res, "ตั้ง lifecycle");
}
