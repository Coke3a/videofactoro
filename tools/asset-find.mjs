import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parse, VfError } from "./out.mjs";
import { resolveProject } from "./paths.mjs";
import { libLoad, libSearch } from "./cache.mjs";

const OPTIONS = { kind: { type: "string" }, character: { type: "string" }, limit: { type: "string" } };

export async function main(argv) {
  const { values, positionals } = parse(argv, OPTIONS);
  const [project, ...terms] = positionals;
  const limit = values.limit === undefined ? 10 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new VfError("USAGE", "--limit ต้องเป็นจำนวนเต็มบวก");
  if (!terms.length) throw new VfError("USAGE", "ต้องระบุคำค้นอย่างน้อย 1 คำ: vf asset find <project> <terms...>");
  const dir = resolveProject(project);
  const loaded = libLoad(dir);
  const lib = { ...loaded, entries: Array.isArray(loaded?.entries) ? loaded.entries : [] };
  const hits = libSearch(lib, terms, { kind: values.kind, character: values.character });
  const results = [];
  for (const { entry, score } of hits) {
    if (typeof entry.blob !== "string" || !entry.blob) continue;
    const file = resolve(dir, entry.blob);
    if (!file.startsWith(dir + sep) || !existsSync(file)) continue;
    results.push({ id: entry.id, kind: entry.kind, file, score, tags: entry.tags ?? [], status: entry.status, need: entry.need ?? null });
    if (results.length >= limit) break;
  }
  return { results };
}
