import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { run, withRetry } from "./cf.mjs";
import { MODELS } from "./models.mjs";
import { estimate } from "./pricing.mjs";
import { logCost } from "./cost.mjs";
import { VfError, log } from "./out.mjs";

const execFileP = promisify(execFile);
const MAX = { images: 4, videos: 2, audio: 4 };
export const NO_PASS_WARNING = "ไม่มีภาพผ่านเกณฑ์ QA — ใช้ภาพคะแนนสูงสุด";

export async function toQaImage(file) {
  const vf = "scale='if(gt(iw,ih),640,-2)':'if(gt(iw,ih),-2,640)'";
  let stdout;
  try {
    ({ stdout } = await execFileP(
      "ffmpeg",
      ["-loglevel", "error", "-i", file, "-vf", vf, "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "pipe:1"],
      { encoding: "buffer", maxBuffer: 1 << 26 },
    ));
  } catch (err) {
    throw new VfError("INTERNAL", `ย่อภาพสำหรับ QA ไม่สำเร็จ: ${file}`, { cause: String(err?.message ?? err).slice(0, 200) });
  }
  return "data:image/jpeg;base64," + stdout.toString("base64");
}

export async function clef({ state, questions, images = [], videos, audio, meta = {}, costDir }) {
  for (const [k, list] of [["images", images], ["videos", videos], ["audio", audio]]) {
    if (list && list.length > MAX[k]) throw new VfError("INTERNAL", `clef-omni รับ ${k} ได้ไม่เกิน ${MAX[k]} (ส่งมา ${list.length})`);
  }
  const input = {
    model: "clef-omni",
    state: typeof state === "string" ? state : JSON.stringify(state),
    questions,
    images,
  };
  if (videos?.length) input.videos = videos;
  if (audio?.length) input.audio = audio;
  const row = { project: meta.project, clip: meta.clip, step: meta.step, model: MODELS.qa };
  let result;
  try {
    ({ result } = await withRetry(() => run(MODELS.qa, input, { meta })));
  } catch (err) {
    logCost(costDir, { ...row, outcome: "error", units: {}, usd: null });
    throw err;
  }
  const u = result?.usage;
  const tokensIn = u?.prompt_tokens ?? u?.input_tokens;
  const units = typeof tokensIn === "number" ? { tokensIn } : {};
  logCost(costDir, { ...row, outcome: "ok", units, usd: estimate(MODELS.qa, { tokensIn, tokensOut: 0 }) });
  const answers = result?.answers;
  if (!answers || typeof answers !== "object") throw new VfError("PROVIDER", "clef-omni ไม่คืน answers");
  return answers;
}

export async function pickBest(candidates, rule, ctx, { meta = {}, costDir } = {}) {
  const ranked = [];
  for (const [i, c] of candidates.entries()) {
    log(`QA ภาพ ${i + 1}/${candidates.length}`);
    const answers = await clef({
      state: rule.state ? rule.state(ctx) : "",
      questions: rule.questions(ctx),
      images: [await toQaImage(c.file)],
      meta,
      costDir,
    });
    ranked.push({ ...c, verdict: rule.judge(answers) });
  }
  ranked.sort((a, b) => Number(b.verdict.pass) - Number(a.verdict.pass) || b.verdict.score - a.verdict.score);
  if (ranked.length && !ranked[0].verdict.pass) ranked[0] = { ...ranked[0], warning: NO_PASS_WARNING };
  return { best: ranked[0], ranked };
}

export async function generateWithQa({ generate, check, maxRerolls = 2 }) {
  const attempts = [];
  for (let attempt = 0; attempt <= maxRerolls; attempt++) {
    const candidate = await generate(attempt);
    const verdict = await check(candidate);
    attempts.push({ candidate, verdict });
    if (verdict.pass) return { best: candidate, verdict, attempts, passed: true };
  }
  const top = attempts.reduce((a, b) => (b.verdict.score > a.verdict.score ? b : a));
  return { best: top.candidate, verdict: top.verdict, attempts, passed: false };
}
