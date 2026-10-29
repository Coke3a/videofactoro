// ขั้นร่วมของ clip / film: ภาพเฟรมแรกจาก ref ตัวละคร + ฉาก (QA) และวิดีโอ i2v ที่ทำต่อได้โดยไม่จ่ายซ้ำ
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { libUpdate } from "./cache.mjs";
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
import { llmJson } from "./llm.mjs";

export const NO_MUSIC = "No background music.";
export const OUTPUT_FLAG_RETRIES = 3;
// กฎวางแผนช็อตที่ส่งเข้าโมเดลวิดีโอ (film/clip): โมเดลทำฉากผาดโผนไม่ได้ ได้ของลอย บันไดหัก ตัวละครซ้ำหรือเปลี่ยนชนิด
// (พบใน mochi-agent "The Ladder Lookout" 2026-10-29)
export const GROUNDED_RULES = [
  "- ฟิสิกส์ต้องเป็นไปได้จริง: ตัวละครและของทุกชิ้นมีสิ่งรองรับที่เห็นในภาพ (พื้น โต๊ะ ชั้น ตะขอบนผนัง) ห้ามของลอยหรือแขวนจากสิ่งที่ไม่อยู่ในภาพ",
  "- ห้ามฉากผาดโผนที่ใช้ฟิสิกส์ซับซ้อน: ของแกว่งเป็นลูกตุ้ม กระโดดหรือเหวี่ยงตัวไปคว้าของกลางอากาศ ห้อยโหน ของพังเป็นชิ้น · ใช้มุกติดพื้นแทน: ลื่น ชน สะดุด ล้มลงบนของนุ่ม ติดอยู่ในกล่องหรือผ้าห่ม ของเบาๆ หล่นใส่หัว",
  "- แต่ละช็อตอยู่สถานที่เดียว first_frame_prompt บอกให้ชัดว่าในบ้านหรือนอกบ้าน (เช่น inside the garage, ceiling visible) และของในฉากต้องเข้ากับสถานที่นั้น",
  "- ตัวละครแต่ละตัวมีในภาพตัวเดียว ทุกครั้งที่เอ่ยชื่อใน prompt ให้บอกชนิดสัตว์ด้วย (เช่น Bean the corgi) ห้ามเพิ่มสัตว์หรือตัวละครอื่น",
];

export const SOFTEN = "Gentle, family-friendly cartoon tone: playful and harmless, no injury, no peril, no scary moments.";

// project.json "keyframe_quality": "high" ใช้ klein-9b กับ keyframe/ภาพนิ่ง (ค่าเริ่มต้นใช้ 4b ที่ถูกกว่า)
export const keyframeModel = (pj) => (pj?.keyframe_quality === "high" ? MODELS.image : MODELS.imageFast);

// flag ที่ผลลัพธ์ (ไม่ใช่ที่ prompt): เปลี่ยน seed แล้วมักผ่าน
export const isOutputFlag = (err) => err instanceof VfError && err.code === "BLOCKED" && /output has been flagged|"code":\s*3030/i.test(err.message);

// ภาพนิ่งหนึ่งภาพของช็อต/ฉาก: ref ตัวละคร (≤3) + plate ของสถานที่ แล้วตรวจด้วย RULES.keyframe
export async function makeKeyframe({ dir, pj, slug, cast, place, prompt, seedKey, need, kind = "keyframe", maxRerolls, meta, out }) {
  const costDir = join(dir, ".vf");
  const charRefs = cast.map((c) => join(dir, "characters", c.id, "ref", "main.png"));
  for (const f of charRefs) if (!existsSync(f)) throw new VfError("USAGE", `ตัวละครยังไม่มีภาพอ้างอิง: ${f}`);
  const plate = place ? join(dir, "places", place.id, "plates", "main.jpg") : null;
  const refs = [...charRefs, ...(plate && existsSync(plate) ? [plate] : [])];
  const refNote = cast.map((c, i) => `Image ${i + 1} is ${c.name}: ${c.look}`).join(" ");
  const placeNote = refs.length > cast.length ? ` Image ${refs.length} is the location; use it only as the background.` : "";
  const fullPrompt = (p) => `${p} ${refNote}${placeNote} ${pj.style_prompt ?? ""}`.trim();
  let rewritten = null; // ทำครั้งเดียวต่อภาพ เมื่อไปถึงระดับที่ต้องเขียนฉากใหม่
  const qaRefs = await Promise.all(charRefs.map((f) => toQaImage(f)));
  const qctx = { characters: cast, shot: prompt, style: pj.style_prompt ?? "" };
  const base = baseSeed(slug, seedKey);
  const model = keyframeModel(pj);
  const res = await generateWithQa({
    maxRerolls,
    generate: async (attempt) => {
      // klein บางครั้ง flag ภาพที่สร้างออกมา (3030 "output has been flagged") แบบสุ่มตาม seed แม้ prompt ไม่มีอะไรผิด
      // seed ตายตัว (resume ได้ผลเดิม) จึงไล่ระดับเองในรอบเดียว: seed ใหม่ → prompt ที่อ่อนลง → LLM เขียนฉากใหม่ → klein-9b
      // บางฉาก flag ทุก seed ทุก ref (เช่น จอทีวีแสงจ้า ตัวละครล้มตกใจ) ต่อท้าย SOFTEN อย่างเดียวไม่พอ ต้องเปลี่ยนเนื้อฉาก
      const tiers = flagTiers(model);
      for (let t = 0; t < tiers.length; t++) {
        const tier = tiers[t];
        if (tier.rewrite && rewritten === null) {
          log(`${kind}: ให้ LLM เขียนฉากใหม่ให้ผ่านตัวกรองภาพ`);
          rewritten = await rewriteForFlag({ prompt, meta: { ...meta, step: `${kind}-rewrite` }, costDir });
        }
        const scene = tier.rewrite ? rewritten : prompt;
        for (let k = 0; k < tier.seeds; k++) {
          try {
            return await generateImage({
              projectDir: dir, prompt: tier.soften ? `${fullPrompt(scene)} ${SOFTEN}` : fullPrompt(scene), refs, aspect: pj.aspect ?? "9:16",
              seed: seedAt(base, attempt + (t * 10 + k) * 100), need,
              kind, characters: cast.map((c) => c.id), place: place?.id ?? null, meta: { ...meta, step: kind }, model: tier.model,
            });
          } catch (err) {
            if (!isOutputFlag(err) || (t === tiers.length - 1 && k === tier.seeds - 1)) throw err;
            log(`${kind}: ภาพถูก flag (${tier.label} ${k + 1}/${tier.seeds}) ลองใหม่`);
          }
        }
      }
      throw new VfError("INTERNAL", "flagTiers ว่าง");
    },
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
    logCost(costDir, { ...costRow(meta, model, kind), outcome: "qa_reject", units: {}, usd: 0, reject_of: a.candidate.entry.id });
    markEntry(dir, a.candidate.entry.id, { status: "rejected" });
  }
  markEntry(dir, res.best.entry.id, { status: res.passed ? "selected" : "candidate", qa: res.best.qa ?? null });
  copyFileSync(res.best.file, join(dir, out));
  return {
    file: out,
    qa: res.best.qa,
    ...(res.passed ? {} : { warning: `${kind} ไม่ผ่าน QA: ${res.verdict.reasons.join(", ")} — ใช้ภาพคะแนนสูงสุด` }),
  };
}

// ลำดับการลองเมื่อภาพถูก flag: รวม OUTPUT_FLAG_RETRIES + 1 seed ในระดับแรก
export function flagTiers(model) {
  return [
    { label: "seed ใหม่", model, soften: false, seeds: OUTPUT_FLAG_RETRIES + 1 },
    { label: "prompt อ่อนลง", model, soften: true, seeds: 2 },
    { label: "ฉากเขียนใหม่", model, soften: true, rewrite: true, seeds: 2 },
    ...(model === MODELS.image ? [] : [{ label: "klein-9b", model: MODELS.image, soften: true, rewrite: true, seeds: 2 }]),
  ];
}

const REWRITE_SYSTEM = `You rewrite one image prompt that an image safety filter keeps flagging, even though the story is family friendly.
Keep the same characters, place, art style, framing and the joke of the moment.
Remove what filters tend to flag: falling, tumbling, crashes, shock or fear, flashing or blasting lights, screens showing other cartoons or brands, weapons or weapon-like props, tight clothing or bare skin, anything that reads as injury or danger.
Show the moment as a calm, readable pose instead. Reply in English as JSON {"prompt": "..."}.`;

export async function rewriteForFlag({ prompt, meta, costDir }) {
  const { data } = await llmJson({
    system: REWRITE_SYSTEM, user: prompt, maxTokens: 1500, meta, costDir,
    schema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    validate: (d) => (typeof d?.prompt === "string" && d.prompt.trim().length >= 20 ? [] : ["prompt ต้องเป็นข้อความอย่างน้อย 20 ตัวอักษร"]),
  });
  return data.prompt.trim();
}

// เขียนผล QA ลงคลัง — คลังพังไม่ควรทำให้ภาพที่ได้แล้วเสีย
function markEntry(dir, id, patch) {
  try { libUpdate(dir, id, patch); } catch { /* entry หาย: ข้าม */ }
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
