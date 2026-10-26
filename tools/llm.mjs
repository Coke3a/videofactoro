import { run, withRetry } from "./cf.mjs";
import { MODELS } from "./models.mjs";
import { estimate } from "./pricing.mjs";
import { logCost, costRow, failOutcome } from "./cost.mjs";
import { VfError, log } from "./out.mjs";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : null);

const family = (model) => (model.startsWith("anthropic/") ? "anthropic" : "gemini");

function strip(node, drop, isNameMap = false) {
  if (Array.isArray(node)) return node.map((n) => strip(n, drop));
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (!isNameMap && drop(k, node)) continue;
    out[k] = strip(v, drop, !isNameMap && k === "properties");
  }
  return out;
}

export const geminiStrip = (schema) =>
  strip(schema, (k, n) => k === "additionalProperties" || (k === "enum" && n.type === "integer"));

function closeObjects(node, isNameMap = false) {
  if (Array.isArray(node)) return node.map((n) => closeObjects(n));
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = closeObjects(v, !isNameMap && k === "properties");
  if (!isNameMap && out.type === "object") out.additionalProperties = false;
  return out;
}

export const anthropicStrip = (schema) =>
  closeObjects(strip(schema, (k) => k === "minItems" || k === "maxItems"));

function splitDataUri(uri) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  if (!m) throw new VfError("USAGE", "ภาพต้องเป็น data URI แบบ data:<mime>;base64,<data>");
  return { mime: m[1], data: m[2] };
}

// วัดจริง: maxOutputTokens 64 -> thinking กิน 61 จน MAX_TOKENS และ parts ว่าง; thinking นับรวมใน maxOutputTokens
const THINKING_HEADROOM = 2048;

export function buildInput(model, { system, messages, schema, maxTokens, images = [] }) {
  const firstUser = messages.findIndex((m) => m.role === "user");
  const pics = images.map(splitDataUri);
  if (family(model) === "anthropic") {
    return {
      system,
      messages: messages.map((m, i) => {
        if (i !== firstUser || !pics.length) return { role: m.role, content: m.content };
        const blocks = pics.map((p) => ({ type: "image", source: { type: "base64", media_type: p.mime, data: p.data } }));
        return { role: m.role, content: [...blocks, { type: "text", text: m.content }] };
      }),
      max_tokens: maxTokens,
      output_config: { format: { type: "json_schema", schema: anthropicStrip(schema) } },
    };
  }
  return {
    contents: messages.map((m, i) => {
      const parts = [{ text: m.content }];
      if (i === firstUser) for (const p of pics) parts.push({ inlineData: { mimeType: p.mime, data: p.data } });
      return { role: m.role === "assistant" ? "model" : "user", parts };
    }),
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: geminiStrip(schema),
      maxOutputTokens: maxTokens + THINKING_HEADROOM,
    },
  };
}

export function readText(model, result) {
  const r = obj(result);
  const empty = { text: "", usage: { in: null, out: null }, truncated: false };
  if (!r) return empty;
  if (family(model) === "anthropic") {
    if (!Array.isArray(r.content)) return empty;
    const text = r.content.map((b) => (obj(b)?.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
    const u = obj(r.usage);
    return { text, usage: { in: num(u?.input_tokens), out: num(u?.output_tokens) }, truncated: r.stop_reason === "max_tokens" };
  }
  const cand = obj(Array.isArray(r.candidates) ? r.candidates[0] : null);
  const parts = cand?.content?.parts;
  const text = (Array.isArray(parts) ? parts : []).map((p) => (typeof obj(p)?.text === "string" ? p.text : "")).join("");
  const u = obj(r.usageMetadata);
  const cOut = num(u?.candidatesTokenCount);
  const tOut = num(u?.thoughtsTokenCount);
  const out = cOut === null && tOut === null ? null : (cOut ?? 0) + (tOut ?? 0);
  return { text, usage: { in: num(u?.promptTokenCount), out }, truncated: cand?.finishReason === "MAX_TOKENS" };
}

function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return { value: JSON.parse(t) }; } catch { return null; }
}

const TRUNCATED_ISSUE = "คำตอบถูกตัดเพราะ maxTokens ไม่พอ";
const PARSE_ISSUE = "ตอบไม่ใช่ JSON ที่ parse ได้";
const feedback = (issues) => `แก้ปัญหาเหล่านี้แล้วตอบ JSON ใหม่ทั้งก้อน:\n${issues.map((i) => `- ${i}`).join("\n")}`;

export async function llmJson({ system, user, schema, validate, images, maxTokens = 8000, meta = {}, costDir }) {
  const allIssues = [];
  let lastErr = null;
  for (const model of MODELS.llm) {
    const messages = [{ role: "user", content: user }];
    for (let round = 1; round <= 2; round++) {
      log(`LLM ${model} รอบ ${round}`);
      const input = buildInput(model, { system, messages, schema, maxTokens, images });
      let text, usage, truncated;
      try {
        const { result } = await withRetry(() => run(model, input, { meta }));
        ({ text, usage, truncated } = readText(model, result));
      } catch (err) {
        logCost(costDir, { ...costRow(meta, model), outcome: failOutcome(err), units: {}, usd: null });
        if (err instanceof VfError && err.code === "PROVIDER") {
          lastErr = err;
          allIssues.push(`${model} รอบ ${round}: ${err.message}`);
          break;
        }
        throw err;
      }
      lastErr = null;
      const parsed = parseJson(text);
      let issues = [truncated ? TRUNCATED_ISSUE : PARSE_ISSUE];
      if (parsed) {
        try { issues = validate ? validate(parsed.value) : []; } catch (e) { issues = ["validator error: " + e.message]; }
      }
      const units = {};
      if (usage.in !== null) units.tokensIn = usage.in;
      if (usage.out !== null) units.tokensOut = usage.out;
      const usd = usage.in !== null && usage.out !== null ? estimate(model, units) : null;
      logCost(costDir, { ...costRow(meta, model), outcome: issues.length ? "invalid" : "ok", units, usd });
      if (!issues.length) return { data: parsed.value, model, usage };
      allIssues.push(...issues.map((i) => `${model} รอบ ${round}: ${i}`));
      log(`LLM ${model} รอบ ${round} ไม่ผ่าน: ${issues.join(" | ").slice(0, 500)}`);
      messages.push({ role: "assistant", content: text || "(ว่าง)" }, { role: "user", content: feedback(issues) });
    }
  }
  if (lastErr) throw new VfError("PROVIDER", lastErr.message, { ...lastErr.details, issues: allIssues });
  throw new VfError("PROVIDER", "LLM ตอบไม่ผ่าน validator", { issues: allIssues });
}
