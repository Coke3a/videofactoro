import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { log, VfError } from "./out.mjs";
import { step } from "./state.mjs";
import { generateImage } from "./images.mjs";
import { generateWithQa, pickBest, saveVerdicts } from "./qa.mjs";
import { RULES } from "./qa-rules.mjs";
import { MODELS } from "./models.mjs";
import { baseSeed, seedAt } from "./project-create.mjs";
import { cutout } from "./cutout.mjs";

export const DEFAULT_POSES = {
  idle: "sitting calmly, facing the viewer, gentle smile",
  happy: "jumping up with joy, front paws raised, big happy open-eyed smile",
  scared: "startled and scared, fur standing up, ears flying up, wide eyes, leaning back",
  sad: "sitting sadly, head down, ears drooping, teary eyes",
  curious: "head tilted to one side, one ear raised, curious look, sniffing forward",
  run: "running to the right, side view, legs stretched mid-stride, ears flapping",
};
export const POSE_FRAME = "Full body, centered, whole character visible with space around it. The character is isolated on a perfectly flat, uniform light cream background: no ground, no floor line, no cast shadow under the feet, no props, no other characters.";
// prompt แก้ภาพ (ไม่ใส่ style_prompt เพราะภาพต้นฉบับมีสไตล์อยู่แล้ว และห้ามเพิ่มฉากหลัง)
export const TALK_PROMPT = "Edit image 1. Keep everything identical: the same character, same pose, same size and position in the frame, same plain flat light cream background with nothing else in it. Change only the mouth: open it slightly as if saying \"ah\". Do not add any room, furniture, window or scenery.";
const TALK_ATTEMPT = 8;

export const posesDir = (dir, cid) => join(dir, "characters", cid, "poses");

// state ไม่ส่งมา = ไม่มี checkpoint (ใช้ในเทสต์/เรียกตรงๆ)
const noState = { get: () => undefined, set() {} };

export async function makePoses({ dir, slug, char, poses = DEFAULT_POSES, maxRerolls = 1, run, costDir, state = noState, salt = "" }) {
  const cid = char.id;
  const ref = join(dir, "characters", cid, "ref", "main.png");
  if (!existsSync(ref)) throw new VfError("USAGE", `ตัวละคร "${cid}" ยังไม่มีภาพ ref (${ref})`);
  const out = posesDir(dir, cid);
  const pj = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const ctx = { look: char.look, style: pj.style_prompt };
  const result = {};

  for (const [name, action] of Object.entries(poses)) {
    const meta = { project: slug, step: "pose", item: `${cid}:${name}`, run };
    const base = baseSeed(slug, `${cid}:pose:${name}${salt}`);
    const pose = await step(state, `pose:${name}`, async () => {
      log(`ขั้น pose:${name}`);
      const res = await generateWithQa({
        maxRerolls,
        generate: (attempt) => generateImage({
          projectDir: dir, model: MODELS.imageFast, refs: [ref], aspect: "3:4", seed: seedAt(base, attempt),
          prompt: `The same character as in image 1 (${char.look}), now ${action}. Keep exactly the same character design, colors and art style as image 1. ${POSE_FRAME} ${pj.style_prompt}`,
          need: `pose:${cid}:${name}`, kind: "character-pose", characters: [cid], tags: [name], meta,
        }),
        check: async (c) => {
          const [r] = (await pickBest([c], RULES.characterRef, ctx, { meta, costDir })).ranked;
          saveVerdicts(dir, [r]);
          return r.verdict;
        },
      });
      return {
        raw: relative(dir, res.best.file), passed: res.passed,
        score: Number.isFinite(res.verdict.score) ? res.verdict.score : null,
      };
    });
    const talk = await step(state, `talk:${name}`, async () => {
      log(`ขั้น talk:${name}`);
      const t = await generateImage({
        projectDir: dir, model: MODELS.imageFast, refs: [resolve(dir, pose.raw)], aspect: "3:4", seed: seedAt(base, TALK_ATTEMPT),
        prompt: TALK_PROMPT, need: `pose:${cid}:${name}:talk`, kind: "character-pose", characters: [cid], tags: [name, "talk"],
        meta: { ...meta, item: `${cid}:${name}:talk` },
      });
      return { raw: relative(dir, t.file) };
    });
    await step(state, `cut:${name}`, async () => {
      log(`ขั้น cut:${name}`);
      mkdirSync(out, { recursive: true });
      await cutout(resolve(dir, pose.raw), join(out, `${name}.png`));
      await cutout(resolve(dir, talk.raw), join(out, `${name}-talk.png`));
      return { done: true };
    });
    result[name] = { file: `${name}.png`, talk: `${name}-talk.png`, score: pose.score, passed: pose.passed };
  }
  return { poses: result };
}

export function loadPoses(dir, cid) {
  const d = posesDir(dir, cid);
  let j;
  try {
    j = JSON.parse(readFileSync(join(d, "poses.json"), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const names = Object.keys(j.poses ?? {});
  return { names, file: (name, talk = false) => join(d, talk ? j.poses[name].talk : j.poses[name].file) };
}
