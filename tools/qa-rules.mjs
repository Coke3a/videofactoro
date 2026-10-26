// ค่าเกณฑ์ทั้งหมดอยู่ที่นี่ (ปรับหลัง spike f)
export const CHAR_MATCH_MIN = 0.5;
export const CHAR_SINGLE_MIN = 0.7;
export const CHAR_TEXT_MAX = 0.3;
export const CHAR_FULLBODY_WEIGHT = 0.2;
export const PLACE_FITS_MIN = 0.5;
export const PLACE_TEXT_MAX = 0.3;
export const PLACE_PEOPLE_MAX = 0.5;
export const PLACE_PEOPLE_WEIGHT = 0.5;
export const KEY_SAME_MIN = 0.6;
export const KEY_FITS_MIN = 0.5;
export const KEY_TEXT_MAX = 0.3;
export const VIDEO_CONSISTENT_MIN = 0.6;
export const VIDEO_MORPH_MIN = 0.6;
export const VIDEO_FOLLOWS_MIN = 0.5;

// คำตอบที่หายไปนับเป็นค่าที่แย่ที่สุด (0 สำหรับข้อ "ดี", 1 สำหรับข้อ "ไม่ดี") จะได้ไม่มีทางผ่านเกณฑ์โดยบังเอิญ
const good = (a, k) => {
  const v = a?.[k]?.noul;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};
const bad = (a, k) => {
  const v = a?.[k]?.noul;
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
};

const q = (instructions) => ({ type: "noul", instructions });
const SINGLE_Q = "Does the image show exactly one character, and no other characters?";
const TEXT_Q = "Are there readable letters, words, logos or watermarks anywhere in the image?";

export const RULES = {
  characterRef: {
    state: (ctx) => `A character reference image. Art style: ${ctx.style}.`,
    questions: (ctx) => ({
      matches_look: q(`Does this image show this character: ${ctx.look}?`),
      single_character: q(SINGLE_Q),
      has_text: q(TEXT_Q),
      full_body: q("Is the character's whole body visible from head to feet?"),
    }),
    judge(a) {
      const matches = good(a, "matches_look");
      const single = good(a, "single_character");
      const text = bad(a, "has_text");
      const full = good(a, "full_body");
      const reasons = [];
      if (!(matches >= CHAR_MATCH_MIN)) reasons.push(`หน้าตาไม่ตรงตัวละคร (${matches.toFixed(2)} < ${CHAR_MATCH_MIN})`);
      if (!(single >= CHAR_SINGLE_MIN)) reasons.push(`ไม่ใช่ตัวละครเดี่ยว (${single.toFixed(2)} < ${CHAR_SINGLE_MIN})`);
      if (!(text < CHAR_TEXT_MAX)) reasons.push(`มีตัวหนังสือหรือโลโก้ในภาพ (${text.toFixed(2)} ≥ ${CHAR_TEXT_MAX})`);
      return { pass: reasons.length === 0, score: matches + CHAR_FULLBODY_WEIGHT * full - text, reasons };
    },
  },
  characterFromImage: {
    state: (ctx) => `A character reference image. Art style: ${ctx.style}.`,
    questions: () => ({
      single_character: q(SINGLE_Q),
      has_text: q(TEXT_Q),
    }),
    judge(a) {
      const single = good(a, "single_character");
      const text = bad(a, "has_text");
      const reasons = [];
      if (!(single >= CHAR_SINGLE_MIN)) reasons.push(`ไม่ใช่ตัวละครเดี่ยว (${single.toFixed(2)} < ${CHAR_SINGLE_MIN})`);
      if (!(text < CHAR_TEXT_MAX)) reasons.push(`มีตัวหนังสือหรือโลโก้ในภาพ (${text.toFixed(2)} ≥ ${CHAR_TEXT_MAX})`);
      return { pass: reasons.length === 0, score: single - text, reasons };
    },
  },
  placePlate: {
    state: (ctx) => `A background plate of a place. Art style: ${ctx.style}.`,
    questions: (ctx) => ({
      fits: q(`Is this the place: ${ctx.desc}, in style ${ctx.style}?`),
      has_text: q("Are there readable letters, words, logos or watermarks anywhere in the image?"),
      has_people_or_animals: q("Are any people, human hands, or animals visible in the image?"),
    }),
    judge(a) {
      const fits = good(a, "fits");
      const text = bad(a, "has_text");
      const pa = bad(a, "has_people_or_animals");
      const reasons = [];
      if (!(fits >= PLACE_FITS_MIN)) reasons.push(`ภาพไม่ตรงสถานที่ (${fits.toFixed(2)} < ${PLACE_FITS_MIN})`);
      if (!(text < PLACE_TEXT_MAX)) reasons.push(`มีตัวหนังสือหรือโลโก้ในภาพ (${text.toFixed(2)} ≥ ${PLACE_TEXT_MAX})`);
      if (!(pa < PLACE_PEOPLE_MAX)) reasons.push(`มีคนหรือสัตว์ในภาพ (${pa.toFixed(2)} ≥ ${PLACE_PEOPLE_MAX})`);
      return { pass: reasons.length === 0, score: fits - text - PLACE_PEOPLE_WEIGHT * pa, reasons };
    },
  },
  // spec §10: ภาพที่ 1..N = ref ของตัวละคร (ตามลำดับ ctx.characters), ภาพสุดท้าย = keyframe
  keyframe: {
    state: (ctx) => `Images 1-${ctx.characters.length} are character references; the last image is a keyframe of a shot. Shot: ${ctx.shot}. Art style: ${ctx.style}.`,
    questions: (ctx) => ({
      ...Object.fromEntries(ctx.characters.map((c, i) => [
        `same_${c.id}`, q(`Does the last image show the same character as Image ${i + 1} (${c.look})?`),
      ])),
      fits_shot: q(`Does the last image match this shot: ${ctx.shot}?`),
      has_text: q("Are there readable letters, words, logos or watermarks anywhere in the last image?"),
    }),
    judge(a, ctx) {
      const reasons = [];
      const sames = ctx.characters.map((c) => {
        const v = good(a, `same_${c.id}`);
        if (!(v >= KEY_SAME_MIN)) reasons.push(`${c.id} ไม่เหมือนภาพอ้างอิง (${v.toFixed(2)} < ${KEY_SAME_MIN})`);
        return v;
      });
      const fits = good(a, "fits_shot");
      const text = bad(a, "has_text");
      if (!(fits >= KEY_FITS_MIN)) reasons.push(`ภาพไม่ตรงช็อต (${fits.toFixed(2)} < ${KEY_FITS_MIN})`);
      if (!(text < KEY_TEXT_MAX)) reasons.push(`มีตัวหนังสือหรือโลโก้ในภาพ (${text.toFixed(2)} ≥ ${KEY_TEXT_MAX})`);
      const same = sames.length ? sames.reduce((x, y) => x + y, 0) / sames.length : 1;
      return { pass: reasons.length === 0, score: same + fits - text, reasons };
    },
  },
  // วิดีโอ: รายงานอย่างเดียว (plan 3 แบบย่อยังไม่สร้างใหม่อัตโนมัติ)
  video: {
    state: (ctx) => `A short video shot. The image is the main character reference. Shot: ${ctx.shot}.`,
    questions: () => ({
      character_consistent: q("Does the character keep the same appearance through the whole video, matching the reference image?"),
      no_morphing: q("Is the video free of morphing, melting shapes, or extra limbs appearing?"),
      follows_prompt: q("Does the video show what the shot description says?"),
      unwanted_text: q("Do readable letters, words or logos appear anywhere in the video?"),
    }),
    judge(a) {
      const cons = good(a, "character_consistent");
      const morph = good(a, "no_morphing");
      const follows = good(a, "follows_prompt");
      const text = bad(a, "unwanted_text");
      const reasons = [];
      if (!(cons >= VIDEO_CONSISTENT_MIN)) reasons.push(`ตัวละครเปลี่ยนหน้าตาระหว่างคลิป (${cons.toFixed(2)} < ${VIDEO_CONSISTENT_MIN})`);
      if (!(morph >= VIDEO_MORPH_MIN)) reasons.push(`มีการบิดเบี้ยว/แขนขางอก (${morph.toFixed(2)} < ${VIDEO_MORPH_MIN})`);
      if (!(follows >= VIDEO_FOLLOWS_MIN)) reasons.push(`ไม่ตรงคำสั่ง (${follows.toFixed(2)} < ${VIDEO_FOLLOWS_MIN})`);
      if (!(text < KEY_TEXT_MAX)) reasons.push(`มีตัวหนังสือในวิดีโอ (${text.toFixed(2)} ≥ ${KEY_TEXT_MAX})`);
      return { pass: reasons.length === 0, score: cons + morph + follows - text, reasons };
    },
  },
};
