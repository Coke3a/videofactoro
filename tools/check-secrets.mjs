// Secret scan for staged files (pre-commit) or whole tree (--all). Prints file names only, never values.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim();
process.chdir(root);
const all = process.argv.includes("--all");
const files = (all
  ? execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"])
  : execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"]))
  .toString().split("\0").filter(Boolean);

const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD/;
const envVals = fs.existsSync(".env")
  ? [...fs.readFileSync(".env", "utf8").matchAll(/^\s*([A-Z0-9_]+)\s*=\s*["']?([^"'\n]+?)["']?\s*$/gm)]
      .filter((m) => SECRET_NAME.test(m[1]) && m[2].length >= 8)
      .map((m) => [m[1], m[2]])
  : [];
const PAT = /((?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}|(?<![A-Za-z0-9])sk_[A-Za-z0-9]{24,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/;
const BIN = /\.(mp4|mp3|wav|pcm|png|jpe?g|webp|gif|woff2?|ttf|otf|pdf)$/i;

const bad = [];
for (const f of files) {
  if (BIN.test(f) || !fs.existsSync(f) || fs.statSync(f).size > 20e6 || !fs.statSync(f).isFile()) continue;
  if (/^\.env($|\.)/.test(path.basename(f)) && path.basename(f) !== ".env.example") { bad.push(`${f}: env file`); continue; }
  const s = fs.readFileSync(f, "utf8");
  for (const [k, v] of envVals) if (s.includes(v)) bad.push(`${f}: มีค่าของ ${k}`);
  if (PAT.test(s)) bad.push(`${f}: ดูเหมือนคีย์ API / private key`);
}
if (bad.length) {
  console.error(`✗ พบสิ่งที่อาจเป็นความลับ — ไม่ commit:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ secret scan: ${files.length} ไฟล์ สะอาด`);
