import { parseArgs } from "node:util";
import { secretValues } from "./env.mjs";

export class VfError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "VfError";
    this.code = code;
    this.details = details;
  }
}

export const EXIT = { USAGE: 2, CONFIG: 3, BLOCKED: 4, PROVIDER: 5, INTERNAL: 1 };

export function redact(text) {
  let out = String(text);
  for (const s of secretValues()) {
    if (s) out = out.split(s).join("***");
  }
  return out;
}

export function emit(result) {
  process.stdout.write(redact(JSON.stringify({ ok: true, ...result })) + "\n");
}

export function fail(err) {
  const e = err instanceof VfError ? err : new VfError("INTERNAL", err?.message ?? String(err));
  const code = e.code in EXIT ? e.code : "INTERNAL";
  const body = { ok: false, error: { code, message: e.message, details: e.details } };
  process.stdout.write(redact(JSON.stringify(body)) + "\n");
  process.exit(EXIT[code]);
}

export function log(...parts) {
  process.stderr.write(redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")) + "\n");
}

export function parse(argv, options = {}) {
  try {
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
    return { values, positionals };
  } catch (e) {
    throw new VfError("USAGE", `อาร์กิวเมนต์ไม่ถูกต้อง: ${e.message}`);
  }
}
