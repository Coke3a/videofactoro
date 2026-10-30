// clef ตรวจว่าท่าตัวละครตรงกับบทที่กำลังพูด (โหมดสินค้า): ภาพกลางบท + ความหมายบท → คะแนนว่าขัดกันไหม
import { poseAt } from "./hf-compose.mjs";

export const POSE_WARN = 0.5;
export const POSE_KEY = "pose_mismatch";
export const POSE_STATE = "One frame from a cartoon clip made of cut-out characters on a painted background, taken while a line is being spoken.";

// บทที่ต้องตรวจ: ฉากตัวละคร ผู้พูดเป็นตัวละคร หรือผู้บรรยายในฉากที่มีตัวเดียว (บรรยายถึงตัวนั้น)
export function poseChecks(plan, times) {
  const out = [];
  plan.scenes.forEach((sc, si) => {
    if ((sc.kind ?? "scene") !== "scene" || !(sc.cast ?? []).length) return;
    const t = times[si];
    (sc.lines ?? []).forEach((l, li) => {
      const who = l.who === "narrator" ? (sc.cast.length === 1 ? sc.cast[0].who : null) : l.who;
      if (!who) return;
      const lt = t.lines[li];
      const mid = (lt.start + lt.end) / 2;
      out.push({ si, li, who, at: Math.round((t.start + mid) * 1000) / 1000, pose: poseAt(sc, t, mid)[who], text: l.text, en: l.en || l.text });
    });
  });
  return out;
}

export const poseQuestion = (c, name) =>
  `The line being spoken is about ${name}: "${c.en}". Does ${name}'s body pose or facial expression in this frame clearly contradict what the line says (e.g. the line says exercising or resting but the character is jumping, or the line is happy but the character is crying)?`;

// ส่งกลับให้ LLM แก้เฉพาะท่าและ beat (บทพูดคงเดิม จึงไม่ต้องอัดเสียงใหม่)
export const FIX_RULES = [
  "You are fixing an existing scene plan. Return the whole plan.",
  "- Keep every scene's id, kind, place, camera, shot, focus, image, chip, props and every line (who, text, en) exactly as they are.",
  "- Change only cast poses and beats in the scenes listed as problems, so that while each listed line is spoken the character's pose shows what the line says. Use only poses that exist for that character.",
].join("\n");

export function fixMessage(plan, found, poseActions) {
  return [
    "Current plan (JSON):",
    JSON.stringify({ scenes: plan.scenes, ...(plan.use_pose ? { use_pose: plan.use_pose } : {}) }),
    "",
    "Problems found by checking the picture:",
    ...found.map((f) => `- scene ${plan.scenes[f.si].id} line ${f.li + 1} (${f.who}, "${f.en}"): shown pose "${f.pose}"${poseActions?.[f.who]?.[f.pose] ? ` (${poseActions[f.who][f.pose]})` : ""} does not fit the line`),
  ].join("\n");
}

// แผนที่แก้แล้วต้องมีบทเหมือนเดิมทุกตัวอักษร (เวลาและเสียงพากย์ผูกกับบท)
export function sameLines(a, b) {
  const sig = (p) => JSON.stringify((p?.scenes ?? []).map((s) => [s.id, (s.lines ?? []).map((l) => [l.who, l.text])]));
  return sig(a) === sig(b);
}
