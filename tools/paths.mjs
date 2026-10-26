import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { VfError } from "./out.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const projectsRoot = () => process.env.VF_PROJECTS || join(REPO_ROOT, "projects");

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isProject = (p) => isDir(p) && (existsSync(join(p, ".vf")) || existsSync(join(p, "PROJECT.md")));

export function resolveProject(nameOrPath) {
  if (!nameOrPath || typeof nameOrPath !== "string") throw new VfError("USAGE", "ต้องระบุ <project>");
  const byPath = isAbsolute(nameOrPath) || /[\\/]/.test(nameOrPath);
  if (!byPath && !NAME_RE.test(nameOrPath)) throw new VfError("USAGE", `ชื่อ project ไม่ถูกต้อง: ${nameOrPath}`);
  const dir = byPath ? resolve(nameOrPath) : join(projectsRoot(), nameOrPath);
  if (!isProject(dir)) throw new VfError("USAGE", `ไม่พบ project: ${nameOrPath}`);
  return dir;
}

export function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function slugify(text) {
  const raw = String(text ?? "");
  const s = raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (s) return s;
  if (raw.trim() === "") return `project-${stamp()}`;
  return `project-${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}
