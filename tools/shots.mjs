// ขั้นร่วมของ clip / film / motion: ภาพเฟรมแรกจาก ref ตัวละคร + ฉาก (QA) และวิดีโอ i2v ที่ทำต่อได้โดยไม่จ่ายซ้ำ
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { libLoad, libUpdate } from "./cache.mjs";
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
export const OUTPUT_FLAG_RETRIES = 3;

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
  const imgPrompt = `${prompt} ${refNote}${placeNote} ${pj.style_prompt ?? ""}`.trim();
  const qaRefs = await Promise.all(charRefs.map((f) => toQaImage(f)));
  const qctx = { characters: cast, shot: prompt, style: pj.style_prompt ?? "" };
  const base = baseSeed(slug, seedKey);
  const model = keyframeModel(pj);
  const res = await generateWithQa({
    maxRerolls,
    generate: async (attempt) => {
      // klein บางครั้ง flag ภาพที่สร้างออกมา (3030 "output has been flagged") แบบสุ่มตาม seed: เปลี่ยน seed แล้วลองใหม่
      for (let k = 0; ; k++) {
        try {
          return await generateImage({
            projectDir: dir, prompt: imgPrompt, refs, aspect: pj.aspect ?? "9:16", seed: seedAt(base, attempt + k * 100), need,
            kind, characters: cast.map((c) => c.id), place: place?.id ?? null, meta: { ...meta, step: kind }, model,
          });
        } catch (err) {
          if (!(isOutputFlag(err) && k < OUTPUT_FLAG_RETRIES)) throw err;
          log(`${kind}: ภาพถูก flag เปลี่ยน seed แล้วลองใหม่ (${k + 1}/${OUTPUT_FLAG_RETRIES})`);
        }
      }
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

// เขียนผล QA ลงคลัง (ให้ reuse เลือกได้) — คลังพังไม่ควรทำให้ภาพที่ได้แล้วเสีย
function markEntry(dir, id, patch) {
  try { libUpdate(dir, id, patch); } catch { /* entry หาย: ข้าม */ }
}

// ---------- reuse ภาพนิ่งเก่าในคลัง (motion) ----------

export const REUSE_CANDIDATES = 3;
export const REUSE_FITS_MIN = 0.75;
export const REUSE_MAX_USES = 3;
const REUSE_OVERLAP_MIN = 0.3;
const REUSE_KINDS = new Set(["still", "keyframe"]);
const words = (t) => new Set(String(t).toLowerCase().match(/[a-z]{4,}/g) ?? []);

// ภาพในคลังที่ตัวละครชุดเดียวกัน ฉากเดียวกัน อัตราส่วนเดียวกัน เรียงตามคำใน prompt ที่ซ้ำกัน
// (ไม่นับคำจากคำอธิบายตัวละครและสไตล์ที่ทุก prompt มีเหมือนกัน)
export function reuseCandidates(lib, { cast, place, prompt, aspect, noise = "", exclude = new Set(), skipNeed = null }) {
  const castKey = cast.map((c) => c.id).sort().join(",");
  const skip = words(noise);
  const want = [...words(prompt)].filter((w) => !skip.has(w));
  if (!want.length) return [];
  const out = [];
  for (const e of lib.entries ?? []) {
    if (!REUSE_KINDS.has(e.kind) || e.status === "rejected" || exclude.has(e.id) || !e.blob) continue;
    if (skipNeed && String(e.need ?? "").startsWith(skipNeed)) continue;
    if ((e.aspect ?? "9:16") !== aspect || (e.place ?? null) !== (place?.id ?? null)) continue;
    if ([...(e.characters ?? [])].sort().join(",") !== castKey) continue;
    if ((e.used_in ?? []).length >= REUSE_MAX_USES) continue;
    const have = words(e.prompt);
    const overlap = want.filter((w) => have.has(w)).length / want.length;
    if (overlap >= REUSE_OVERLAP_MIN) out.push({ entry: e, overlap: overlap + (e.status === "selected" ? 0.1 : 0) });
  }
  return out.sort((a, b) => b.overlap - a.overlap).slice(0, REUSE_CANDIDATES).map((x) => x.entry);
}

// ให้ clef ตัดสินว่าภาพเก่าใช้แทนฉากนี้ได้ไหม (เกณฑ์ fits_shot เข้มกว่าตอนสร้างใหม่) ได้ = copy ไปที่ out แล้วบันทึก used_in
// reserved: Set ที่ใช้ร่วมกันทั้งคลิป กันสองฉากหยิบภาพเดียวกัน · skipNeed: prefix need ของภาพที่ทำในคลิปนี้เอง
export async function reuseStill({ dir, pj, cast, place, prompt, use, reserved, skipNeed, meta, out }) {
  const lib = libLoad(dir);
  const noise = `${cast.map((c) => `${c.name} ${c.look}`).join(" ")} ${pj.style_prompt ?? ""}`;
  const cands = reuseCandidates(lib, { cast, place, prompt, aspect: pj.aspect ?? "9:16", noise, exclude: reserved, skipNeed });
  if (!cands.length) return null;
  const costDir = join(dir, ".vf");
  const qaRefs = await Promise.all(cast.map((c) => toQaImage(join(dir, "characters", c.id, "ref", "main.png"))));
  const qctx = { characters: cast, shot: prompt, style: pj.style_prompt ?? "" };
  for (const e of cands) {
    if (reserved.has(e.id)) continue;
    reserved.add(e.id);
    const file = join(dir, e.blob);
    if (!existsSync(file)) continue;
    log(`reuse: ให้ clef ดูภาพเก่า ${e.id}`);
    const answers = await clef({
      state: RULES.keyframe.state(qctx), questions: RULES.keyframe.questions(qctx),
      images: [...qaRefs, await toQaImage(file)], meta, costDir,
    });
    const verdict = RULES.keyframe.judge(answers, qctx);
    const fits = answers?.fits_shot?.noul;
    if (!verdict.pass || !(typeof fits === "number" && fits >= REUSE_FITS_MIN)) {
      log(`reuse: ไม่ใช้ ${e.id} (fits ${typeof fits === "number" ? fits.toFixed(2) : "?"})`);
      continue;
    }
    copyFileSync(file, join(dir, out));
    markEntry(dir, e.id, { used_in: [...(e.used_in ?? []), use] });
    logCost(costDir, { ...costRow(meta, e.model ?? MODELS.imageFast, "still"), outcome: "ok", units: { images: 1 }, usd: 0, cached: true, reused: e.id });
    return { file: out, qa: qaRecord(verdict, answers), reused: e.id };
  }
  return null;
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
