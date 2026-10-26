import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim();
const hook = path.join(root, ".git", "hooks", "pre-commit");
fs.mkdirSync(path.dirname(hook), { recursive: true });
fs.writeFileSync(hook, '#!/bin/sh\nexec node "$(git rev-parse --show-toplevel)/tools/check-secrets.mjs"\n', { mode: 0o755 });
fs.chmodSync(hook, 0o755);
console.log(`ติดตั้ง pre-commit hook แล้ว: ${hook}`);
