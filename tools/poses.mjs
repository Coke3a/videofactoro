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
// พื้นเขียว chroma key ตัดด้วย greenKey ใน cutout.mjs; ไม่ใส่ style_prompt ของ project เพราะ style แนว 3D/ภาพยนตร์
// พาฉากหลัง แสงไล่ระดับ และเงามาด้วย พื้นจึงไม่เรียบและตัดไม่ออก (ภาพ ref มีสไตล์อยู่แล้ว)
export const POSE_FRAME = "Full body, centered, whole character visible with generous empty space around it, including above the head and ears. The character is isolated on a solid flat pure chroma-key green (#00FF00) background, evenly lit, no gradient, no vignette, no ground, no floor line, no cast shadow, no scenery, no props, no other characters. Clean studio cut-out look.";
// prompt แก้ภาพ (ไม่ใส่ style_prompt เพราะภาพต้นฉบับมีสไตล์อยู่แล้ว และห้ามเพิ่มฉากหลัง ต้องคงพื้นเขียวไว้)
// ตาต้องเหมือนเดิมเป๊ะ ไม่งั้นตากระพริบทุกครั้งที่ปากขยับ
export const TALK_PROMPT = "Edit image 1. Keep everything identical: the same character, same pose, same size and position in the frame, same solid flat pure green (#00FF00) background with nothing else in it. Keep the eyes exactly as they are (open or closed, gaze direction, shape and size), and keep the eyebrows, ears, paws, tail, body and every other detail unchanged; add nothing new to the face. Change only the mouth: open it slightly as if saying \"ah\". Do not add any room, furniture, window or scenery.";
// ห้ามเอ่ยถึงน้ำตาใน prompt: ตัวแก้ภาพเติมน้ำตาให้ท่าที่ไม่ได้ร้องไห้ (Pip happy/run)
// seed ภาพอ้าปาก = base + 8, 9, 10 (ไม่ชน seed ของท่าที่ใช้ 0..maxRerolls)
const TALK_ATTEMPT = 8;
export const TALK_MAX_REROLLS = 2;

export const posesDir = (dir, cid) => join(dir, "characters", cid, "poses");

// state ไม่ส่งมา = ไม่มี checkpoint (ใช้ในเทสต์/เรียกตรงๆ)
const noState = { get: () => undefined, set() {} };

export async function makePoses({ dir, slug, char, poses = DEFAULT_POSES, maxRerolls = 1, run, costDir, state = noState, salt = "" }) {
  const cid = char.id;
  const ref = join(dir, "characters", cid, "ref", "main.png");
  if (!existsSync(ref)) throw new VfError("USAGE", `ตัวละคร "${cid}" ยังไม่มีภาพ ref (${ref})`);
  const out = posesDir(dir, cid);
  const pj = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const result = {};
  const score = (v) => (Number.isFinite(v.score) ? v.score : null);
  const check = async (c, rule, ctx, meta, lead) => {
    const [r] = (await pickBest([c], rule, ctx, { meta, costDir, lead })).ranked;
    saveVerdicts(dir, [r]);
    return r.verdict;
  };

  for (const [name, action] of Object.entries(poses)) {
    const ctx = { look: char.look, style: pj.style_prompt, pose: name, action };
    const meta = { project: slug, step: "pose", item: `${cid}:${name}`, run };
    const base = baseSeed(slug, `${cid}:pose:${name}${salt}`);
    const pose = await step(state, `pose:${name}`, async () => {
      log(`ขั้น pose:${name}`);
      const res = await generateWithQa({
        maxRerolls,
        generate: (attempt) => generateImage({
          projectDir: dir, model: MODELS.imageFast, refs: [ref], aspect: "3:4", seed: seedAt(base, attempt),
          prompt: `The same character as in image 1 (${char.look}), now ${action}. Keep exactly the same character design, colors and art style as image 1. ${POSE_FRAME}`,
          need: `pose:${cid}:${name}`, kind: "character-pose", characters: [cid], tags: [name], meta,
        }),
        check: (c) => check(c, RULES.characterPose, ctx, meta),
      });
      return { raw: relative(dir, res.best.file), passed: res.passed, score: score(res.verdict) };
    });
    const talk = await step(state, `talk:${name}`, async () => {
      log(`ขั้น talk:${name}`);
      const poseFile = resolve(dir, pose.raw);
      const tmeta = { ...meta, item: `${cid}:${name}:talk` };
      // QA เทียบภาพท่ากับภาพอ้าปาก: ตา/คิ้ว/ตัวต้องเหมือนเดิม ไม่งั้นตากระพริบตามปาก
      const res = await generateWithQa({
        maxRerolls: TALK_MAX_REROLLS,
        generate: (attempt) => generateImage({
          projectDir: dir, model: MODELS.imageFast, refs: [poseFile], aspect: "3:4", seed: seedAt(base, TALK_ATTEMPT + attempt),
          prompt: TALK_PROMPT, need: `pose:${cid}:${name}:talk`, kind: "character-pose", characters: [cid], tags: [name, "talk"], meta: tmeta,
        }),
        check: (c) => check(c, RULES.talkTwin, {}, tmeta, [poseFile]),
      });
      return { raw: relative(dir, res.best.file), passed: res.passed, score: score(res.verdict) };
    });
    await step(state, `cut:${name}`, async () => {
      log(`ขั้น cut:${name}`);
      mkdirSync(out, { recursive: true });
      await cutout(resolve(dir, pose.raw), join(out, `${name}.png`));
      await cutout(resolve(dir, talk.raw), join(out, `${name}-talk.png`));
      return { done: true };
    });
    result[name] = {
      file: `${name}.png`, talk: `${name}-talk.png`, score: pose.score, passed: pose.passed,
      talk_score: talk.score ?? null, talk_passed: talk.passed ?? null,
    };
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
  // --replace ที่ค้างครึ่งทางทิ้ง poses.json ที่ชี้ไปยังไฟล์ที่ถูกเก็บเข้า archive แล้ว → ถือว่าท่านั้นไม่มี
  const names = Object.keys(j.poses ?? {}).filter((n) => [j.poses[n].file, j.poses[n].talk].every((f) => !f || existsSync(join(d, f))));
  return { names, file: (name, talk = false) => join(d, talk ? j.poses[name].talk : j.poses[name].file) };
}
