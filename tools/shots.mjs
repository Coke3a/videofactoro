// ขั้นร่วมของ clip / film / motion: ภาพเฟรมแรกจาก ref ตัวละคร + ฉาก (QA) และวิดีโอ i2v ที่ทำต่อได้โดยไม่จ่ายซ้ำ
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VfError, log } from "./out.mjs";
import { generateImage } from "./images.mjs";
import { generateWithQa, clef, toQaImage, qaRecord } from "./qa.mjs";
import { RULES } from "./qa-rules.mjs";
import { run as cfRun, withRetry, extractMedia, download } from "./cf.mjs";
import { MODELS } from "./models.mjs";
import { estimate } from "./pricing.mjs";
import { logCost, costRow, failOutcome } from "./cost.mjs";
import { baseSeed, seedAt } from "./project-create.mjs";

export const NO_MUSIC = "No background music.";

// ภาพนิ่งหนึ่งภาพของช็อต/ฉาก: ref ตัวละคร (≤3) + plate ของสถานที่ แล้วตรวจด้วย RULES.keyframe
export async function makeKeyframe({ dir, pj, slug, cast, place, prompt, seedKey, need, kind = "keyframe", maxRerolls, meta, out }) {
  const costDir = join(dir, ".vf");
  const charRefs = cast.map((c) => join(dir, "characters", c.id, "ref", "main.png"));
  for (const f of charRefs) if (!existsSync(f)) throw new VfError("USAGE", `ตัวละครยังไม่มีภาพอ้างอิง: ${f}`);
  const plate = place ? join(dir, "places", place.id, "plates", "main.jpg") : null;
  const refs = [...charRefs, ...(plate && existsSync(plate) ? [plate] : [])];
  const refNote = cast.map((c, i) => `Image ${i + 1} is ${c.name}: ${c.look}`).join(" ");
  const placeNote = refs.length > cast.length ? ` Image ${refs.length} is the location; use it only as the background.` : "";
  const imgPrompt = `${prompt} ${refNote}${placeNote} ${pj.style_prompt ?? ""}`.trim();
  const qaRefs = await Promise.all(charRefs.map((f) => toQaImage(f)));
  const qctx = { characters: cast, shot: prompt, style: pj.style_prompt ?? "" };
  const base = baseSeed(slug, seedKey);
  const res = await generateWithQa({
    maxRerolls,
    generate: (attempt) => generateImage({
      projectDir: dir, prompt: imgPrompt, refs, aspect: pj.aspect ?? "9:16", seed: seedAt(base, attempt), need,
      kind, characters: cast.map((c) => c.id), place: place?.id ?? null, meta: { ...meta, step: kind },
    }),
    check: async (c) => {
      log(`QA ${kind}`);
      const answers = await clef({
        state: RULES.keyframe.state(qctx), questions: RULES.keyframe.questions(qctx),
        images: [...qaRefs, await toQaImage(c.file)], meta, costDir,
      });
      const verdict = RULES.keyframe.judge(answers, qctx);
      c.qa = qaRecord(verdict, answers);
      return verdict;
    },
  });
  for (const a of res.attempts) {
    if (a.verdict.pass || a.candidate === res.best) continue;
    logCost(costDir, { ...costRow(meta, MODELS.image, kind), outcome: "qa_reject", units: {}, usd: 0, reject_of: a.candidate.entry.id });
  }
  copyFileSync(res.best.file, join(dir, out));
  return {
    file: out,
    qa: res.best.qa,
    ...(res.passed ? {} : { warning: `${kind} ไม่ผ่าน QA: ${res.verdict.reasons.join(", ")} — ใช้ภาพคะแนนสูงสุด` }),
  };
}

// flux-3-video i2v: เก็บ request id ไว้ใน state[requestKey] ก่อนรอผล รันซ้ำจะตามงานเดิม ไม่ POST ใหม่
export async function makeVideo({ dir, state, requestKey, keyframe, prompt, duration, hd, aspect, meta, out }) {
  const costDir = join(dir, ".vf");
  const quality = hd ? "hd" : "draft";
  const vprompt = prompt.includes(NO_MUSIC) ? prompt : `${prompt} ${NO_MUSIC}`;
  const input = {
    mode: "i2v", prompt: vprompt, keyframes: readFileSync(join(dir, keyframe)).toString("base64"),
    aspect_ratio: aspect, duration, resolution: "hd", generate_audio: true, ...(hd ? {} : { draft: true }),
  };
  const row = costRow(meta, MODELS.video, "video");
  const pending = state.get(requestKey)?.id;
  let result;
  try {
    ({ result } = pending
      ? await cfRun(MODELS.video, input, { meta: { ...meta, step: "video" }, resumeRequestId: pending })
      : await withRetry(() => cfRun(MODELS.video, input, {
        meta: { ...meta, step: "video" },
        onRequestId: (rid) => state.set(requestKey, { id: rid }),
      })));
  } catch (err) {
    // มี request id แล้วแปลว่าอาจจ่ายไปแล้ว: ไม่ลงเงินซ้ำ รันซ้ำจะตามงานเดิมต่อ
    logCost(costDir, { ...row, outcome: failOutcome(err), units: { clips: 1, quality, seconds: duration }, usd: null });
    throw err;
  }
  await download(extractMedia(result), join(dir, out));
  logCost(costDir, { ...row, outcome: "ok", units: { clips: 1, quality, seconds: duration }, usd: estimate(MODELS.video, { clips: 1, quality }) });
  return { file: out, quality };
}

// รันงานพร้อมกันได้ไม่เกิน n งาน คืนผลตามลำดับเดิม; งานแรกที่ล้มทำให้ทั้งชุดล้ม (งานที่เหลือยังรันจนจบเพื่อเก็บ state)
export async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  let firstErr = null;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        firstErr ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (firstErr) throw firstErr;
  return results;
}
