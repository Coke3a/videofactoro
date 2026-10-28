import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./out.mjs";
import { step, writeJsonAtomic } from "./state.mjs";
import { generateImage } from "./images.mjs";
import { MODELS } from "./models.mjs";
import { baseSeed } from "./project-create.mjs";
import { cutout } from "./cutout.mjs";
import { ID_RE } from "./bible.mjs";

export const PROP_ID_RE = ID_RE;
export const propDir = (dir, id) => join(dir, "props", id);
const noState = { get: () => undefined, set() {} };

// เรียกตรงได้จาก vf motion (ไม่ต้องมี job/state); state ใส่มาเฉพาะตอนต้องการ checkpoint
export async function makeProp({ dir, slug, id, desc, run, costDir, state = noState }) {
  const pj = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const out = propDir(dir, id);
  const raw = await stepOnce(state, "gen", async () => {
    log(`ขั้น prop:${id}`);
    const img = await generateImage({
      projectDir: dir, model: MODELS.imageFast, aspect: "1:1", seed: baseSeed(slug, `prop:${id}`),
      prompt: `${desc}. A single object, whole object visible, centered, on a plain flat light cream background, no shadow, nothing else. ${pj.style_prompt}`,
      need: `prop:${id}`, kind: "prop", tags: [id], meta: { project: slug, step: "prop", item: id, run },
    });
    return { raw: img.file };
  });
  await stepOnce(state, "cut", async () => {
    log(`ขั้น cut:${id}`);
    mkdirSync(out, { recursive: true });
    await cutout(raw.raw, join(out, "prop.png"), { shadowTol: 0 }); // prop ไม่มีเงา ข้าม shadow pass
    writeJsonAtomic(join(out, "prop.json"), { id, desc, created: new Date().toISOString() });
    return { done: true };
  });
  return { id, file: `props/${id}/prop.png` };
}

const stepOnce = (state, name, fn) => (state === noState ? fn() : step(state, `prop:${name}`, fn));

export function listProps(dir) {
  const root = join(dir, "props");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "prop.json")) && existsSync(join(root, e.name, "prop.png")))
    .map((e) => {
      const j = JSON.parse(readFileSync(join(root, e.name, "prop.json"), "utf8"));
      return { id: j.id ?? e.name, desc: j.desc ?? "", file: `props/${e.name}/prop.png` };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
