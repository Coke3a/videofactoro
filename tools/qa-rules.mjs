// ค่าเกณฑ์ทั้งหมดอยู่ที่นี่ (ปรับหลัง spike f)
export const CHAR_MATCH_MIN = 0.5;
export const CHAR_SINGLE_MIN = 0.7;
export const CHAR_TEXT_MAX = 0.3;
export const CHAR_FULLBODY_WEIGHT = 0.2;
export const PLACE_FITS_MIN = 0.5;
export const PLACE_TEXT_MAX = 0.3;
export const PLACE_PEOPLE_MAX = 0.5;
export const PLACE_PEOPLE_WEIGHT = 0.5;

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

export const RULES = {
  characterRef: {
    state: (ctx) => `A character reference image. Art style: ${ctx.style}.`,
    questions: (ctx) => ({
      matches_look: q(`Does this image show this character: ${ctx.look}?`),
      single_character: q("Does the image show exactly one character, and no other characters?"),
      has_text: q("Are there readable letters, words, logos or watermarks anywhere in the image?"),
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
};
