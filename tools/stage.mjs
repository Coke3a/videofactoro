import path from "node:path";
import { clef, toQaImage } from "./qa.mjs";
import { readJson, writeJsonAtomic } from "./state.mjs";
import { VfError } from "./out.mjs";

export const DEFAULT_STAGE = { floor: 0.87, spots: { left: 0.25, center: 0.5, right: 0.75, "far-left": 0.12, "far-right": 0.88 } };
const MIN_CLEAR = 0.5;
const STATE = "A background scene plate for a short animated video.";

const question = (x) => ({
  type: "noul",
  instructions: `Is the floor area at the bottom of the image around ${Math.round(x * 100)}% from the left free of furniture, so a small animal could stand there?`,
});

export async function stageFor({ dir, place, meta = {}, costDir, state = STATE }) {
  const id = typeof place === "string" ? place : place.id;
  const file = path.join(dir, "places", id, "place.json");
  const pj = readJson(file);
  if (pj.stage) return pj.stage;

  const names = Object.keys(DEFAULT_STAGE.spots);
  const questions = Object.fromEntries(names.map((n) => [`clear_${n}`, question(DEFAULT_STAGE.spots[n])]));
  let answers;
  try {
    const image = await toQaImage(path.join(path.dirname(file), pj.plate));
    answers = await clef({ state, questions, images: [image], meta, costDir });
  } catch (err) {
    // ล้มเฉพาะฝั่งผู้ให้บริการ → ใช้ค่าเริ่มต้นโดยไม่แคช ครั้งหน้าจะลองถามใหม่
    if (err instanceof VfError && err.code === "PROVIDER") return DEFAULT_STAGE;
    throw err;
  }
  const score = (n) => {
    const v = Number(answers?.[`clear_${n}`]?.noul);
    return Number.isFinite(v) ? v : 0;
  };
  const ranked = [...names].sort((a, b) => score(b) - score(a));
  let keep = names.filter((n) => score(n) >= MIN_CLEAR);
  if (keep.length < 2) keep = ranked.slice(0, 2);
  const stage = { floor: DEFAULT_STAGE.floor, spots: Object.fromEntries(names.filter((n) => keep.includes(n)).map((n) => [n, DEFAULT_STAGE.spots[n]])) };
  writeJsonAtomic(file, { ...pj, stage });
  return stage;
}

export function spotX(stage, name) {
  const x = stage?.spots?.[name];
  if (typeof x !== "number") throw new VfError("INTERNAL", `ไม่รู้จักตำแหน่งยืน: ${name}`);
  return x;
}
