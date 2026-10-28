// ของร่วมสำหรับเทส vf motion (HyperFrames): ท่าตัวละคร, แผน story/scenes, hf runner ปลอม
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { PARTS } from "../../tools/motion-plan.mjs";

export const TINY = fileURLToPath(new URL("./tiny.png", import.meta.url));
export const STORY_MARK = "You write the story";
export const SCENES_MARK = "5-part gag outline";
export const STAGING_KEY = "staging_problem";

export function writePoses(dir, cid, names = ["idle", "happy"]) {
  const d = path.join(dir, "characters", cid, "poses");
  fs.mkdirSync(d, { recursive: true });
  const poses = {};
  for (const n of names) {
    fs.copyFileSync(TINY, path.join(d, `${n}.png`));
    fs.copyFileSync(TINY, path.join(d, `${n}-talk.png`));
    poses[n] = { file: `${n}.png`, talk: `${n}-talk.png`, score: 0.9, passed: true };
  }
  fs.writeFileSync(path.join(d, "poses.json"), JSON.stringify({ poses }));
}

// project ภาษาอังกฤษ (คลิปจริงของ Hermes เป็นอังกฤษ) + ท่าของทุกตัวละคร
export function prepareMotionProject(dir) {
  const f = path.join(dir, "project.json");
  const pj = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...pj, lang: "en" }));
  for (const c of pj.characters) writePoses(dir, c.id);
}

export const STORY = () => ({
  title: "Ball Panic",
  summary: "The cat and the dog chase a red ball.",
  music_prompt: "Bouncy ukulele, 120 BPM",
  beats: PARTS.map((part) => ({ part, text: `The cat and the dog play the ${part} gag.` })),
  props_needed: [{ id: "ball", desc: "a red rubber ball" }],
});

const sc = (i, narrator = true) => ({
  id: `s0${i}`, place: "kitchen", camera: i % 2 ? "push" : "static",
  cast: [{ who: "cat", spot: "left", pose: "idle", enter: "drop" }, { who: "dog", spot: "right", pose: "idle" }],
  props: i === 1 ? [{ id: "ball", spot: "center" }] : [],
  lines: [{ who: narrator ? "narrator" : "cat", text: "The cat sees something shiny." }, { who: "dog", text: "Look at that ball!" }],
  beats: [{ at: "line2", who: "cat", pose: "happy", move: "hop", sfx: "boing" }, { at: "1", fx: "shake", sfx: "whoosh" }],
});
// ประมาณ 5 วินาทีต่อฉาก × 4 = 20 วินาที (ตาม estimateSeconds)
export const SCENES = ({ narrator = true } = {}) => ({ scenes: [1, 2, 3, 4].map((i) => sc(i, narrator)) });
// ไม่มีบทพูดเลย: ฉากละ SCENE_MIN 3 วินาที × 7 ≈ 21 วินาที
export const SILENT_SCENES = () => ({ scenes: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ ...sc(i), lines: [], beats: [{ at: "1", who: "cat", move: "hop", sfx: "pop" }] })) });

// hf runner ปลอม: lint ตามที่สั่ง, snapshot = png ต่อเวลา, render = วิดีโอดำยาวเท่า data-duration ของ root
export function stubRunner(opt = {}) {
  const seen = [];
  const envs = [];
  const fn = async (args, o) => {
    seen.push(args);
    envs.push(o?.env);
    const [cmd, dir] = args;
    if (cmd === "lint") return { stdout: opt.lint ?? "◇  0 error(s), 1 warning(s)\n⚠ overlapping_gsap_tweens: two tweens", stderr: "" };
    if (cmd === "snapshot") {
      const at = args[args.indexOf("--at") + 1].split(",");
      const out = args[args.indexOf("-o") + 1];
      fs.mkdirSync(out, { recursive: true });
      // ชื่อเดียวกับ hyperframes 0.8.153 (+ contact sheet ที่ไม่ใช่ png)
      at.forEach((t, i) => fs.copyFileSync(TINY, path.join(out, `frame-${String(i).padStart(2, "0")}-at-${t}s.png`)));
      fs.copyFileSync(TINY, path.join(out, "contact-sheet.jpg"));
      return { stdout: "" };
    }
    if (cmd === "render") {
      // จำลองไฟล์ชั่วคราวของ render ใน TMPDIR
      if (o?.env?.TMPDIR) fs.writeFileSync(path.join(o.env.TMPDIR, "chunk.tmp"), "x");
      if (opt.renderFail?.()) throw new Error("render boom");
      const out = args[args.indexOf("-o") + 1];
      if (opt.renderEmpty) { fs.writeFileSync(out, ""); return { stdout: "" }; }
      const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
      const d = /id="root"[^>]*data-duration="([\d.]+)"/.exec(html)[1];
      execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=108x192:r=30:d=${d}`, "-pix_fmt", "yuv420p", "-c:v", "libx264", out]);
      return { stdout: "" };
    }
    throw new Error(`unexpected hyperframes ${cmd}`);
  };
  fn.seen = seen;
  fn.envs = envs;
  return fn;
}
