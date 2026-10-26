import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./out.mjs";
import { resolveProject } from "./paths.mjs";
import { loadProject } from "./entities.mjs";
import { readCosts, summarize } from "./cost.mjs";

const listFiles = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(d, e.name)).sort() : []);
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function readEpisodes(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().startsWith("|"));
  if (!lines.length) return [];
  const head = cells(lines[0]);
  return lines
    .slice(1)
    .map(cells)
    .filter((c) => !c.every((x) => /^:?-+:?$/.test(x)))
    .map((c) => Object.fromEntries(head.map((h, i) => [h, c[i] ?? ""])));
}

export async function main(argv) {
  const { positionals } = parse(argv, {});
  const dir = resolveProject(positionals[0]);
  const { pj, slug, lang, characters, places } = loadProject(dir);
  const episodesMd = join(dir, "EPISODES.md");
  const rows = readEpisodes(episodesMd);
  return {
    project: slug,
    dir,
    title: pj.title ?? slug,
    logline: pj.logline ?? "",
    lang,
    aspect: pj.aspect ?? "9:16",
    narrator: pj.narrator === true,
    characters: characters.map((c) => {
      const ref = join(dir, "characters", c.id, "ref", "main.png");
      return { id: c.id, name: c.name, role: c.role, ref: existsSync(ref) ? ref : null, poses: listFiles(join(dir, "characters", c.id, "poses")) };
    }),
    places: places.map((p) => ({ id: p.id, name: p.name, plates: listFiles(join(dir, "places", p.id, "plates")) })),
    episodes: rows.length,
    last_episodes: rows.slice(-5),
    cost_total_usd: summarize(readCosts(join(dir, ".vf"))).totalUsd,
    files: { project_md: join(dir, "PROJECT.md"), episodes_md: episodesMd },
  };
}
