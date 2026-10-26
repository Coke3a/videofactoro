// vf clip: คลิปสั้นช็อตเดียวจาก prompt (spec §6.2 แบบย่อ: ยังไม่มี end frame, TTS, เพลง, poster)
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, VfError, log } from "./out.mjs";
import { resolveProject, slugify } from "./paths.mjs";
import { llmJson } from "./llm.mjs";
import { openState, step, writeJsonAtomic } from "./state.mjs";
import { riskFindings } from "./risk.mjs";
import { recordEpisode, ID_RE } from "./bible.mjs";
import { generateImage } from "./images.mjs";
import { generateWithQa, clef, toQaImage, qaRecord } from "./qa.mjs";
import { RULES } from "./qa-rules.mjs";
import { run as cfRun, withRetry, extractMedia, download } from "./cf.mjs";
import { MODELS } from "./models.mjs";
import { estimate } from "./pricing.mjs";
import { logCost, costRow, failOutcome } from "./cost.mjs";
import { baseSeed, seedAt, sha } from "./project-create.mjs";
import { pinInput, pinRun, costSince, contextMessage, loadProject, planRows, llmRow, imageRow, qaRow, runEntity } from "./entities.mjs";

const execFileP = promisify(execFile);
const MAX_CHARS = 3;
const NO_MUSIC = "No background music.";

const OPTIONS = {
  prompt: { type: "string" },
  duration: { type: "string" },
  hd: { type: "boolean" },
  id: { type: "string" },
  "max-rerolls": { type: "string" },
  foreground: { type: "boolean" },
  "dry-run": { type: "boolean" },
};

export const CLIP_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    duration: { type: "integer" },
    characters: { type: "array", items: { type: "string" } },
    place: { type: "string" },
    first_frame_prompt: { type: "string" },
    video_prompt: { type: "string" },
  },
  required: ["title", "summary", "duration", "characters", "place", "first_frame_prompt", "video_prompt"],
};

export function clipSystemPrompt(lang) {
  return [
    "คุณคือผู้กำกับที่วางแผนคลิปสั้นช็อตเดียวจาก project วิดีโอที่มีอยู่แล้ว ตอบเป็น JSON ตาม schema เท่านั้น",
    `- characters: id ตัวละครที่อยู่ในช็อต 1–${MAX_CHARS} ตัว เลือกจาก id ที่มีอยู่เท่านั้น`,
    '- place: id สถานที่ที่มีอยู่ หรือ "" ถ้าไม่มีที่ไหนเหมาะ',
    "- duration: วินาที 5–20 (ช็อตเดียว เรื่องเล็กๆ ส่วนใหญ่ 5–8)",
    "- first_frame_prompt (ภาษาอังกฤษ): ภาพนิ่งเฟรมแรกของช็อต บอกตำแหน่ง ท่าทาง สีหน้าของแต่ละตัว และฉาก ไม่มี motion blur ห้ามมีตัวอักษร ป้าย หรือโลโก้ในภาพ",
    "- video_prompt (ภาษาอังกฤษ): สิ่งที่เกิดขึ้นในคลิปเป็นเส้นเวลา 2–3 จังหวะต่อ 5 วินาที เช่น \"0-2s: ... 2-5s: ...\" บอกการเคลื่อนไหวของกล้องและเสียงในฉาก ถ้ามีบทพูดให้ใส่ในเครื่องหมายคำพูด",
    "- ห้ามใช้ชื่อคนจริง แบรนด์ หรือตัวละครมีลิขสิทธิ์",
    `- title และ summary เป็นภาษา ${lang}`,
  ].join("\n");
}

export function validateClipPlan(plan, { characters, places }, { duration } = {}) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return ["แผนคลิปต้องเป็น object"];
  const issues = [];
  for (const k of ["title", "summary", "first_frame_prompt", "video_prompt"]) {
    if (typeof plan[k] !== "string" || plan[k].trim() === "") issues.push(`${k} ต้องเป็นข้อความที่ไม่ว่าง`);
  }
  if (duration === undefined && !(Number.isInteger(plan.duration) && plan.duration >= 5 && plan.duration <= 20)) {
    issues.push("duration ต้องเป็นจำนวนเต็ม 5–20");
  }
  const ids = new Set(characters.map((c) => c.id));
  const chars = Array.isArray(plan.characters) ? plan.characters : [];
  if (chars.length < 1 || chars.length > MAX_CHARS) issues.push(`characters ต้องมี 1–${MAX_CHARS} ตัว`);
  if (new Set(chars).size !== chars.length) issues.push("characters ซ้ำกัน");
  for (const id of chars) if (!ids.has(id)) issues.push(`ไม่มีตัวละคร id "${id}" ใน project (มี: ${[...ids].join(", ")})`);
  if (plan.place && !places.some((p) => p.id === plan.place)) issues.push(`ไม่มีสถานที่ id "${plan.place}" ใน project`);
  for (const k of ["first_frame_prompt", "video_prompt", "title"]) {
    for (const f of riskFindings(String(plan[k] ?? ""))) issues.push(`${k} มีคำเสี่ยง: ${f.matched}`);
  }
  return issues;
}

// วิดีโอย่อ 480p ไม่มีเสียง สำหรับ clef (spec §10)
async function toQaVideo(file) {
  const tmp = mkdtempSync(join(tmpdir(), "vf-qav-"));
  try {
    const out = join(tmp, "qa.mp4");
    await execFileP("ffmpeg", ["-loglevel", "error", "-y", "-i", file, "-vf", "scale=-2:480", "-an", "-c:v", "libx264", "-crf", "30", "-preset", "veryfast", out]);
    return "data:video/mp4;base64," + readFileSync(out).toString("base64");
  } catch (err) {
    throw new VfError("INTERNAL", `ย่อวิดีโอสำหรับ QA ไม่สำเร็จ: ${file}`, { cause: String(err?.message ?? err).slice(0, 200) });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function dryRun(duration, hd) {
  const quality = hd ? "hd" : "draft";
  return {
    dry_run: true,
    ...planRows([
      llmRow(4000, 600),
      imageRow("keyframe", 1),
      qaRow(2),
      { step: "video", model: MODELS.video, count: 1, usd: estimate(MODELS.video, { clips: 1, quality }) },
    ]),
    assumptions: [
      "LLM วางแผน 1 ครั้ง (PROJECT.md + prompt ≈ 4000 tokens เข้า / 600 ออก)",
      "keyframe 1 ภาพ (ไม่มี reroll) · QA keyframe 1 + วิดีโอ 1",
      `วิดีโอ ${quality} 1 คลิป${duration ? ` ${duration} วินาที` : ""} — ราคาวิดีโอยังไม่ยืนยัน (คิดต่อคลิป)`,
    ],
  };
}

async function work({ dir, ctx, state, key, prompt, duration, hd, maxRerolls, run: fresh }) {
  const { pj, slug, lang, characters, places } = ctx;
  const run = pinRun(state, fresh);
  const costDir = join(dir, ".vf");
  const aspect = pj.aspect ?? "9:16";

  const plan = await step(state, "plan", async () => {
    log("ขั้น plan");
    const user = contextMessage({
      dir, characters, places, prompt,
      notes: [
        `ตัวละครที่ใช้ได้: ${characters.map((c) => `${c.id} (${c.name})`).join(", ")}`,
        `สถานที่ที่ใช้ได้: ${places.map((p) => `${p.id} (${p.name})`).join(", ") || "(ไม่มี)"}`,
        ...(duration ? [`ความยาวคลิป: ${duration} วินาที (บังคับ)`] : []),
      ],
    });
    const { data } = await llmJson({
      system: clipSystemPrompt(lang), user, schema: CLIP_SCHEMA,
      validate: (p) => validateClipPlan(p, ctx, { duration }),
      meta: { project: slug, step: "clip-plan", item: key, run }, costDir,
    });
    return { ...data, place: data.place || null, duration: duration ?? data.duration };
  });

  const id = `${slugify(plan.title).slice(0, 40).replace(/-+$/, "")}-${key.slice(-4)}`;
  const clipDir = join(dir, "clips", id);
  mkdirSync(clipDir, { recursive: true });
  writeJsonAtomic(join(clipDir, "plan.json"), { prompt, ...plan });
  const cast = plan.characters.map((cid) => characters.find((c) => c.id === cid));
  const place = plan.place ? places.find((p) => p.id === plan.place) : null;
  const meta = { project: slug, clip: id, item: id, run };

  const key1 = await step(state, "keyframe", async () => {
    log("ขั้น keyframe");
    const charRefs = cast.map((c) => join(dir, "characters", c.id, "ref", "main.png"));
    for (const f of charRefs) if (!existsSync(f)) throw new VfError("USAGE", `ตัวละครยังไม่มีภาพอ้างอิง: ${f}`);
    const plate = place ? join(dir, "places", place.id, "plates", "main.jpg") : null;
    const refs = [...charRefs, ...(plate && existsSync(plate) ? [plate] : [])];
    const refNote = cast.map((c, i) => `Image ${i + 1} is ${c.name}: ${c.look}`).join(" ");
    const placeNote = refs.length > cast.length ? ` Image ${refs.length} is the location; use it only as the background.` : "";
    const imgPrompt = `${plan.first_frame_prompt} ${refNote}${placeNote} ${pj.style_prompt ?? ""}`.trim();
    const qaRefs = await Promise.all(charRefs.map((f) => toQaImage(f)));
    const qctx = { characters: cast, shot: plan.first_frame_prompt, style: pj.style_prompt ?? "" };
    const base = baseSeed(slug, `clip:${id}`);
    const res = await generateWithQa({
      maxRerolls,
      generate: (attempt) => generateImage({
        projectDir: dir, prompt: imgPrompt, refs, aspect, seed: seedAt(base, attempt), need: `keyframe:${id}`,
        kind: "keyframe", characters: plan.characters, place: plan.place, meta: { ...meta, step: "keyframe" },
      }),
      check: async (c) => {
        log("QA keyframe");
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
      logCost(costDir, { ...costRow(meta, MODELS.image, "keyframe"), outcome: "qa_reject", units: {}, usd: 0, reject_of: a.candidate.entry.id });
    }
    copyFileSync(res.best.file, join(clipDir, "keyframe.jpg"));
    return {
      file: `clips/${id}/keyframe.jpg`,
      qa: res.best.qa,
      ...(res.passed ? {} : { warning: `keyframe ไม่ผ่าน QA: ${res.verdict.reasons.join(", ")} — ใช้ภาพคะแนนสูงสุด` }),
    };
  });

  const video = await step(state, "video", async () => {
    log(`ขั้น video (${hd ? "hd" : "draft"} ${plan.duration} วินาที)`);
    const quality = hd ? "hd" : "draft";
    const vprompt = plan.video_prompt.includes(NO_MUSIC) ? plan.video_prompt : `${plan.video_prompt} ${NO_MUSIC}`;
    const input = {
      mode: "i2v", prompt: vprompt, keyframes: readFileSync(join(dir, key1.file)).toString("base64"),
      aspect_ratio: aspect, duration: plan.duration, resolution: "hd", generate_audio: true, ...(hd ? {} : { draft: true }),
    };
    const row = costRow(meta, MODELS.video, "video");
    const pending = state.get("video-request")?.id;
    let result;
    try {
      ({ result } = pending
        ? await cfRun(MODELS.video, input, { meta: { ...meta, step: "video" }, resumeRequestId: pending })
        : await withRetry(() => cfRun(MODELS.video, input, {
          meta: { ...meta, step: "video" },
          onRequestId: (rid) => state.set("video-request", { id: rid }),
        })));
    } catch (err) {
      // มี request id แล้วแปลว่าอาจจ่ายไปแล้ว: ไม่ลงเงินซ้ำ รันซ้ำจะตามงานเดิมต่อ
      logCost(costDir, { ...row, outcome: failOutcome(err), units: { clips: 1, quality, seconds: plan.duration }, usd: null });
      throw err;
    }
    const out = join(clipDir, "clip.mp4");
    await download(extractMedia(result), out);
    logCost(costDir, { ...row, outcome: "ok", units: { clips: 1, quality, seconds: plan.duration }, usd: estimate(MODELS.video, { clips: 1, quality }) });
    return { file: `clips/${id}/clip.mp4`, quality };
  });

  const vqa = await step(state, "video-qa", async () => {
    log("QA วิดีโอ (รายงานอย่างเดียว)");
    const qctx = { shot: plan.video_prompt };
    try {
      const answers = await clef({
        state: RULES.video.state(qctx), questions: RULES.video.questions(qctx),
        images: [await toQaImage(join(dir, "characters", cast[0].id, "ref", "main.png"))],
        videos: [await toQaVideo(join(dir, video.file))], meta, costDir,
      });
      return qaRecord(RULES.video.judge(answers), answers);
    } catch (e) {
      if (e instanceof VfError && ["PROVIDER", "INTERNAL"].includes(e.code)) return { pass: null, error: e.message };
      throw e;
    }
  });

  await step(state, "files", async () => {
    log("ขั้น files");
    writeJsonAtomic(join(clipDir, "qa.json"), { keyframe: key1.qa ?? null, video: vqa });
    mkdirSync(join(dir, "renders"), { recursive: true });
    copyFileSync(join(dir, video.file), join(dir, "renders", `${id}.mp4`));
    recordEpisode(dir, {
      date: new Date().toISOString().slice(0, 10), mode: `clip ${video.quality}`, title: plan.title, summary: plan.summary,
      characters: plan.characters, file: `renders/${id}.mp4`,
    });
    return { done: true, id };
  });

  const warnings = [key1.warning, vqa.pass === false ? `วิดีโอไม่ผ่าน QA: ${vqa.reasons.join(", ")}` : null,
    vqa.error ? `QA วิดีโอทำไม่สำเร็จ: ${vqa.error}` : null].filter(Boolean);
  return {
    clip: {
      id, title: plan.title, duration: plan.duration, quality: video.quality, characters: plan.characters, place: plan.place,
      file: join(dir, "renders", `${id}.mp4`), keyframe: key1.file, ...(warnings.length ? { warnings } : {}),
    },
    cost: { usd: costSince(costDir, run) },
    next: video.quality === "draft" ? [`vf clip ${slug} --prompt "..." --hd  # ทำใหม่แบบ hd เมื่อพอใจ`] : [`vf project show ${slug}`],
  };
}

export async function main(argv) {
  const { values, positionals } = parse(argv, OPTIONS);
  const prompt = values.prompt?.trim();
  if (!prompt) throw new VfError("USAGE", 'ต้องระบุ --prompt "..."');
  const duration = values.duration === undefined ? undefined : Number(values.duration);
  if (duration !== undefined && !(Number.isInteger(duration) && duration >= 5 && duration <= 20)) {
    throw new VfError("USAGE", "--duration ต้องเป็นจำนวนเต็ม 5–20");
  }
  const id = values.id;
  if (id !== undefined && !ID_RE.test(id)) throw new VfError("USAGE", "--id ต้องเป็น a-z 0-9 และ - ขึ้นต้นด้วยตัวอักษร ยาว 2–31 ตัว");
  const maxRerolls = values["max-rerolls"] === undefined ? 2 : Number(values["max-rerolls"]);
  if (!Number.isInteger(maxRerolls) || maxRerolls < 0 || maxRerolls > 5) throw new VfError("USAGE", "--max-rerolls ต้องเป็นจำนวนเต็ม 0–5");
  const hd = Boolean(values.hd);
  const dir = resolveProject(positionals[0]);
  const ctx = loadProject(dir);
  if (!ctx.characters.length) throw new VfError("USAGE", "project นี้ยังไม่มีตัวละคร");
  if (values["dry-run"]) return dryRun(duration, hd);

  const promptSha = sha(prompt);
  const key = id ?? `h${sha(`${prompt}\0${duration ?? ""}\0${hd}`).slice(0, 8)}`;
  const stateDir = join(dir, ".vf");
  const openRun = () => {
    const state = openState(stateDir, `clip-${key}-state.json`);
    if (state.get("files")?.status === "done") {
      throw new VfError("USAGE", `ทำคลิปนี้เสร็จแล้ว: ${state.get("files").output.id} (เปลี่ยน prompt หรือใส่ --id ใหม่เพื่อทำอีกคลิป)`);
    }
    mkdirSync(stateDir, { recursive: true });
    pinInput(state, { prompt_sha: promptSha, duration: duration ?? null, hd, max_rerolls: maxRerolls }, ["prompt_sha", "duration", "hd", "max_rerolls"],
      "ของคลิปที่ทำค้างไว้ ให้ใช้ input เดิมเพื่อทำต่อ หรือใส่ --id ใหม่เพื่อเริ่มคลิปใหม่");
    return state;
  };

  const command = ["clip", dir, `--prompt=${prompt}`, `--max-rerolls=${maxRerolls}`,
    ...(duration ? [`--duration=${duration}`] : []), ...(hd ? ["--hd"] : []), ...(id ? [`--id=${id}`] : [])];
  return await runEntity({
    dir, projectRef: positionals[0], slug: ctx.slug, command, label: `clip ${key}`, foreground: values.foreground,
    work: ({ run }) => work({ dir, ctx, state: openRun(), key, prompt, duration, hd, maxRerolls, run }),
  });
}
