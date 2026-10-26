// Spike f: calibrate clef-omni thresholds. Same-character vs different-character pairs (5 each), text vs no-text images (3 each).
// Spend: about 12 klein images (~$0.12) + 5 R2 uploads + about 16 clef-omni calls (cheap).
// Run: node spikes/f-clef.mjs   (prints same_character and has_text distributions + a suggested threshold)
import fs from "node:fs";
import { run, withRetry, extractMedia, download } from "../tools/cf.mjs";
import { uploadTemp } from "../tools/r2.mjs";
import { clef, toQaImage } from "../tools/qa.mjs";
import { MODELS } from "../tools/models.mjs";
import { out, facts } from "./_lib.mjs";

const costDir = out("f-costs");
const klein = async (name, prompt, images, seed) => {
  const file = out(`f-${name}.png`);
  if (!fs.existsSync(file)) {
    const input = { prompt, aspect_ratio: "9:16", resolution: "1k", seed };
    if (images) input.images = images;
    const { result } = await withRetry(() => run(MODELS.image, input));
    await download(extractMedia(result), file);
  }
  return file;
};
const SUFFIX = " No text, no letters, no logos.";
const scene = ["eating a sandwich", "jumping happily", "sleeping", "reading a book", "waving"];
const kinds = ["a blue robot with round eyes", "a green frog wearing a red scarf", "a purple dragon with tiny wings", "a yellow duck in a raincoat", "a grey wolf with a backpack"];

const baseFile = await klein("base", "An orange cat mascot with a white belly, full body, flat cartoon style." + SUFFIX, null, 7);
const baseUrl = await uploadTemp(baseFile);

const same = [], diff = [];
for (let i = 0; i < 5; i++) {
  same.push(await klein(`same${i}`, `The same orange cat mascot ${scene[i]}, flat cartoon style.` + SUFFIX, [baseUrl], 100 + i));
  diff.push(await klein(`diff${i}`, `${kinds[i]}, full body, flat cartoon style.` + SUFFIX, null, 200 + i));
}
const withText = [], noText = [];
for (let i = 0; i < 3; i++) {
  withText.push(await klein(`text${i}`, `A poster with the big words "SALE ${i + 1}0%" and a small cat drawing, flat cartoon style.`, null, 300 + i));
  noText.push(await klein(`notext${i}`, `A small cat drawing on a plain background, flat cartoon style.` + SUFFIX, null, 400 + i));
}

const noul = (a, k) => a?.[k]?.noul ?? null;
const q = (instructions) => ({ type: "noul", instructions });
const base64 = await toQaImage(baseFile);

async function sameScore(file) {
  const a = await clef({
    state: "Two images of cartoon characters.",
    questions: { same_character: q("Is the character in the second image the same character as in the first image?") },
    images: [base64, await toQaImage(file)], costDir,
  });
  return noul(a, "same_character");
}
async function textScore(file) {
  const a = await clef({
    state: "An image to check.",
    questions: { has_text: q("Are there readable letters, words, logos or watermarks anywhere in the image?") },
    images: [await toQaImage(file)], costDir,
  });
  return noul(a, "has_text");
}

const dist = {
  same_character: { same: [], different: [] },
  has_text: { with_text: [], without_text: [] },
};
for (const f of same) dist.same_character.same.push(await sameScore(f));
for (const f of diff) dist.same_character.different.push(await sameScore(f));
for (const f of withText) dist.has_text.with_text.push(await textScore(f));
for (const f of noText) dist.has_text.without_text.push(await textScore(f));

const nums = (a) => a.filter((x) => typeof x === "number");
const suggestGe = (hi, lo) => {
  const h = nums(hi), l = nums(lo);
  if (!h.length || !l.length) return null;
  const minHi = Math.min(...h), maxLo = Math.max(...l);
  return { min_of_positive_group: minHi, max_of_negative_group: maxLo, separable: minHi > maxLo, suggested: +((minHi + maxLo) / 2).toFixed(3) };
};
facts("f-clef", {
  distributions: dist,
  suggested_CHAR_MATCH_MIN_for_same_character: suggestGe(dist.same_character.same, dist.same_character.different),
  suggested_CHAR_TEXT_MAX_for_has_text: (() => { const s = suggestGe(dist.has_text.with_text, dist.has_text.without_text); return s && { ...s, note: "use value < suggested as 'no text'" }; })(),
  note: "compare with current qa-rules.mjs constants before changing (CHAR_MATCH_MIN, CHAR_TEXT_MAX)",
});
