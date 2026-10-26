import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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

export function resolveProject(nameOrPath) {
  if (!nameOrPath) throw new VfError("USAGE", "ต้องระบุ <project>");
  const direct = resolve(nameOrPath);
  const hasSep = isAbsolute(nameOrPath) || /[\\/]/.test(nameOrPath);
  if (hasSep && isDir(direct)) return direct;
  const byName = join(projectsRoot(), nameOrPath);
  if (existsSync(byName) && isDir(byName)) return byName;
  if (isDir(direct) && existsSync(join(direct, "PROJECT.md"))) return direct;
  throw new VfError("USAGE", `ไม่พบ project: ${nameOrPath}`);
}

export function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function slugify(text) {
  const s = String(text ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || `project-${stamp()}`;
}
