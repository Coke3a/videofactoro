// เสียงประกอบสังเคราะห์ด้วย ffmpeg (ไม่มีค่า API): whoosh ตอนตัดฉาก, ding ตอนการ์ดเด้ง, impact/boing ตอนพีกของฉาก
// whirr/pop/bang ใช้ใน motion แบบ HyperFrames (แผนเลือกเองต่อ beat)
import { VfError } from "./out.mjs";

// จุดพีกของฉาก (สัดส่วนของความยาวฉาก) — คำเสียง ASS, แฟลช/punch-in และเสียง impact ใช้เวลาเดียวกัน
export const HIT_AT = 0.4;
export const SFX_GAIN = 0.55;
const WHOOSH_LEAD = 0.2; // whoosh ดังสุดตรงจุดตัด

const GRAPHS = {
  whoosh: "anoisesrc=d=0.4:c=pink:a=0.5:seed=7,bandpass=f=1200:width_type=o:w=2,afade=t=in:d=0.2:curve=qsin,afade=t=out:st=0.2:d=0.2:curve=qsin[out]",
  impact: "sine=f=58:d=0.45,volume=0.9[s];anoisesrc=d=0.45:c=brown:a=0.7:seed=3,lowpass=f=900[n];[s][n]amix=inputs=2:normalize=0,afade=t=out:st=0.01:d=0.44:curve=exp[out]",
  ding: "sine=f=1568:d=0.9[a];sine=f=2349:d=0.9,volume=0.5[b];[a][b]amix=inputs=2:normalize=0,afade=t=out:st=0.01:d=0.89:curve=exp,volume=0.35[out]",
  boing: "aevalsrc='0.6*sin(2*PI*t*(180+90*sin(2*PI*7*t)))*exp(-5*t)':d=0.5:s=48000[out]",
  whirr: "anoisesrc=d=1.4:c=pink:a=0.5:seed=5,bandpass=f=700:width_type=h:w=400,tremolo=f=22:d=0.7,afade=t=in:d=0.1,afade=t=out:st=1.1:d=0.3[out]",
  pop: "sine=f=520:d=0.14,afade=t=out:st=0.02:d=0.12[out]",
  bang: "sine=f=70:d=0.6,volume=0.9[s];anoisesrc=d=0.6:c=white:a=0.9:seed=11,lowpass=f=2500[n];[s][n]amix=inputs=2:normalize=0,afade=t=out:st=0.005:d=0.595:curve=exp[out]",
};
export const SFX_KINDS = Object.keys(GRAPHS);

export function sfxSynthArgs(kind, out) {
  if (!GRAPHS[kind]) throw new VfError("INTERNAL", `ไม่รู้จัก sfx: ${kind}`);
  return ["-filter_complex", GRAPHS[kind], "-map", "[out]", "-ar", "48000", "-ac", "2", out];
}

// เวลาเสียงประกอบทั้งคลิปจากรายการฉาก ({seconds, card, sfx_word, move})
export function motionCues(scenes) {
  const cues = [];
  let at = 0;
  scenes.forEach((s, i) => {
    if (i > 0) cues.push({ kind: "whoosh", at: Math.max(0, Math.round((at - WHOOSH_LEAD) * 100) / 100) });
    if (s.card) cues.push({ kind: "ding", at: at + 0.05 });
    if (s.sfx_word) cues.push({ kind: s.move === "bounce" ? "boing" : "impact", at: at + s.seconds * HIT_AT });
    at += s.seconds;
  });
  return cues.sort((a, b) => a.at - b.at);
}
