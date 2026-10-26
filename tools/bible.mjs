import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { riskFindings } from "./risk.mjs";
import { replaceAuto } from "./md.mjs";
import { readCosts, summarize, renderCostTable } from "./cost.mjs";
import { writeJsonAtomic } from "./state.mjs";

// เสียง prebuilt ของ Gemini TTS 30 ชื่อ (genhaha/app/lib/cinematic/board.ts)
export const GEMINI_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

const str = { type: "string" };
const strList = { type: "array", items: str };

export const BIBLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title", "logline", "premise", "world", "style_prompt", "palette", "visual_rules", "narrator",
    "narrator_voice", "tone", "music_style", "lang", "characters", "places", "story_rules",
  ],
  properties: {
    title: str, logline: str, premise: str, world: str, style_prompt: str,
    palette: { type: "array", minItems: 3, maxItems: 6, items: str },
    visual_rules: strList,
    narrator: { type: "boolean" },
    narrator_voice: { type: "string", enum: GEMINI_VOICES },
    tone: str, music_style: str, lang: str,
    characters: {
      type: "array", minItems: 1, maxItems: 6,
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "name", "role", "look", "personality", "voice_description", "tts_voice"],
        properties: {
          id: str, name: str, role: str, look: str, personality: str, voice_description: str,
          tts_voice: { type: "string", enum: GEMINI_VOICES },
        },
      },
    },
    places: {
      type: "array", minItems: 1, maxItems: 4,
      items: { type: "object", additionalProperties: false, required: ["id", "name", "desc"], properties: { id: str, name: str, desc: str } },
    },
    story_rules: strList,
  },
};

const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const MIN_LOOK = 120;
const TEXT_FIELDS = ["title", "logline", "premise", "world", "style_prompt", "tone", "music_style", "lang"];
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

function risks(label, text, issues) {
  const raw = String(text ?? "");
  const low = raw.toLowerCase();
  for (const f of riskFindings(raw)) {
    const i = low.indexOf(f.matched);
    const word = i >= 0 ? raw.slice(i, i + f.matched.length) : f.matched;
    issues.push(`${label} มีคำเสี่ยง: ${word}`);
  }
}

export function validateBible(b) {
  const issues = [];
  if (b === null || typeof b !== "object" || Array.isArray(b)) return ["bible ต้องเป็น object"];
  for (const k of TEXT_FIELDS) if (!nonEmpty(b[k])) issues.push(`${k} ต้องเป็นข้อความที่ไม่ว่าง`);
  if (typeof b.narrator !== "boolean") issues.push("narrator ต้องเป็น true/false");
  if (b.narrator && !GEMINI_VOICES.includes(b.narrator_voice)) issues.push(`narrator_voice ไม่อยู่ในรายชื่อเสียง Gemini TTS: ${b.narrator_voice}`);
  for (const k of ["visual_rules", "story_rules"]) {
    if (!Array.isArray(b[k]) || b[k].some((x) => !nonEmpty(x))) issues.push(`${k} ต้องเป็นรายการข้อความ`);
  }
  if (!Array.isArray(b.palette) || b.palette.length < 3 || b.palette.length > 6 || b.palette.some((c) => !HEX_RE.test(String(c)))) {
    issues.push("palette ต้องมี 3–6 สี รูปแบบ #RRGGBB");
  }
  const chars = Array.isArray(b.characters) ? b.characters : [];
  const places = Array.isArray(b.places) ? b.places : [];
  if (chars.length < 1 || chars.length > 6) issues.push("characters ต้องมี 1–6 ตัว");
  if (places.length < 1 || places.length > 4) issues.push("places ต้องมี 1–4 แห่ง");
  const seen = new Set();
  const checkId = (kind, id) => {
    if (!ID_RE.test(String(id))) issues.push(`id ของ${kind} "${id}" ผิดรูปแบบ (ต้องเป็น a-z0-9- ขึ้นต้นด้วยตัวอักษร 2–31 ตัว)`);
    if (seen.has(id)) issues.push(`id "${id}" ซ้ำ`);
    seen.add(id);
  };
  for (const c of chars) {
    checkId("ตัวละคร", c?.id);
    for (const k of ["name", "role", "personality", "voice_description"]) {
      if (!nonEmpty(c?.[k])) issues.push(`${k} ของ ${c?.id} ต้องไม่ว่าง`);
    }
    if (typeof c?.look !== "string" || c.look.length < MIN_LOOK) {
      issues.push(`look ของ ${c?.id} สั้นเกินไป (${String(c?.look ?? "").length} < ${MIN_LOOK} ตัวอักษร) ต้องบอกสี ลาย สัดส่วน จุดเด่นที่ต้องคงที่`);
    }
    if (!GEMINI_VOICES.includes(c?.tts_voice)) issues.push(`tts_voice ของ ${c?.id} ไม่อยู่ในรายชื่อเสียง Gemini TTS: ${c?.tts_voice}`);
    risks(`look ของ ${c?.id}`, c?.look, issues);
  }
  for (const p of places) {
    checkId("สถานที่", p?.id);
    for (const k of ["name", "desc"]) if (!nonEmpty(p?.[k])) issues.push(`${k} ของ ${p?.id} ต้องไม่ว่าง`);
  }
  risks("title", b.title, issues);
  risks("style_prompt", b.style_prompt, issues);
  risks("premise", b.premise, issues);
  return issues;
}

export function bibleSystemPrompt(lang) {
  return [
    "คุณคือผู้เขียน story bible สำหรับโปรเจกต์วิดีโอสั้น ตอบเป็น JSON ตาม schema เท่านั้น",
    "- เขียนเฉพาะภาพใหญ่ของเรื่อง (ตัวละคร สถานที่ โลก สไตล์ กฎของเรื่อง) ไม่ใช่สคริปต์หรือสตอรีบอร์ดของวิดีโอ",
    "- look ของแต่ละตัวละครต้องละเอียดอย่างน้อย 120 ตัวอักษร: บอกสี ลาย สัดส่วน และจุดเด่นที่ต้องคงที่ทุกภาพ (look ถูกใส่ใน prompt ภาพทุกครั้งคำต่อคำ)",
    "- ห้ามใช้ชื่อคนจริง แบรนด์ หรือตัวละครมีลิขสิทธิ์ทั้งในชื่อและคำบรรยาย ถ้า prompt ของผู้ใช้พูดถึง ให้แทนด้วยตัวละครต้นฉบับที่ออกแบบใหม่",
    "- style_prompt ไม่ใช้โทนน้ำเงิน-ม่วง เว้นแต่ prompt ของผู้ใช้ขอ; palette 3–6 สีรูปแบบ #RRGGBB",
    "- เลือก narrator (true/false) และ narrator_voice ตามแนวเรื่อง; tts_voice ต้องเป็นเสียงจากรายชื่อใน schema",
    "- id ของตัวละครและสถานที่ใช้ a-z 0-9 และ - เท่านั้น ขึ้นต้นด้วยตัวอักษร ห้ามซ้ำกัน",
    `- ข้อความในฟิลด์ทั้งหมดเป็นภาษา ${lang} ยกเว้น look และ style_prompt ที่ต้องเป็นภาษาอังกฤษเสมอ (desc ของสถานที่เป็นภาษาอังกฤษด้วยเพื่อใช้สร้างภาพ)`,
    `- ตั้งค่า lang เป็น "${lang}"`,
  ].join("\n");
}

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const list = (xs) => (xs?.length ? xs.map((x) => `- ${x}`).join("\n") : "- (ยังไม่มี)");

function charactersTable(b) {
  const rows = b.characters.map((c) => `| ${cell(c.id)} | ${cell(c.name)} | ${cell(c.role)} | characters/${c.id}/CHARACTER.md |`);
  return ["| id | ชื่อ | บทบาท | ไฟล์ |", "|---|---|---|---|", ...rows].join("\n");
}
function placesTable(b) {
  const rows = b.places.map((p) => `| ${cell(p.id)} | ${cell(p.name)} | ${cell(p.desc)} | places/${p.id}/PLACE.md |`);
  return ["| id | ชื่อ | คำอธิบาย | ไฟล์ |", "|---|---|---|---|", ...rows].join("\n");
}
function fileMap() {
  return [
    "- `project.json` ค่าที่เครื่องอ่าน (lang, aspect, style_prompt, palette, narrator)",
    "- `characters/<id>/CHARACTER.md`, `character.json`, `ref/main.png` ภาพอ้างอิงหลัก (ส่งเป็น reference ทุกครั้ง)",
    "- `places/<id>/PLACE.md`, `place.json`, `plates/main.jpg` ภาพฉากไม่มีตัวละคร",
    "- `library/index.json` คลังภาพ (ภาพที่ไม่ได้เลือกยังเก็บไว้ที่ `library/blobs/`)",
    "- `EPISODES.md` ตอนที่ทำแล้ว · `.vf/` state และต้นทุนของ project",
    "- เพิ่มตัวละคร: `vf character add <project> --prompt ...` · เพิ่มสถานที่: `vf place add <project> --prompt ...`",
  ].join("\n");
}

function projectMd(b) {
  return [
    `# ${b.title}`,
    "",
    "## เรื่องย่อ (logline + premise)",
    b.logline,
    "",
    b.premise,
    "",
    "## โลก (ที่ไหน ยุคไหน กฎของโลก)",
    b.world,
    "",
    "## สไตล์ภาพ",
    `style_prompt (ใส่ใน prompt ภาพทุกครั้งคำต่อคำ):`,
    "",
    `> ${b.style_prompt}`,
    "",
    `ชุดสี: ${b.palette.join(" ")}`,
    "",
    "สิ่งที่ห้ามและกฎภาพ:",
    list(b.visual_rules),
    "",
    "## เสียงและอารมณ์",
    `- ผู้บรรยาย: ${b.narrator ? `เปิด (เสียง ${b.narrator_voice})` : "ปิด"}`,
    `- โทนการเล่า: ${b.tone}`,
    `- แนวเพลง: ${b.music_style}`,
    "",
    "## ตัวละคร",
    "",
    "## สถานที่",
    "",
    "## กฎของเรื่อง",
    list(b.story_rules),
    "",
    "## แผนที่ไฟล์",
    "",
    "## ต้นทุนสะสม (อัปเดตอัตโนมัติ)",
    "",
  ].join("\n");
}

function under(text, heading, name, content) {
  const at = text.indexOf(`\n${heading}`);
  const marker = `<!-- vf:auto:${name} -->`;
  if (text.includes(marker) || at < 0) return replaceAuto(text, name, content);
  const eol = text.indexOf("\n", at + 1);
  const rest = eol < 0 ? "" : text.slice(eol);
  return `${text.slice(0, eol < 0 ? text.length : eol)}\n${replaceAuto("", name, content).trim()}\n${rest}`;
}

function characterMd(c, b) {
  return [
    `# ${c.name} (${c.id})`,
    "",
    `บทบาท: ${c.role}`,
    "",
    "## รูปร่าง (look) — ใส่ใน prompt ทุกครั้งแบบคำต่อคำ",
    c.look,
    "",
    "## นิสัย",
    c.personality,
    "",
    "## เสียง",
    `- เสียง TTS: ${c.tts_voice}`,
    `- ลักษณะเสียง: ${c.voice_description}`,
    "",
    "## ข้อห้าม",
    list(["ไม่มีตัวอักษรหรือโลโก้ในภาพ", ...(b.visual_rules ?? [])]),
    "",
  ].join("\n");
}

function placeMd(p) {
  return [`# ${p.name} (${p.id})`, "", "## คำอธิบายฉาก (ใส่ใน prompt ภาพแบบคำต่อคำ)", p.desc, "", "ภาพฉากไม่มีตัวละคร: plates/main.jpg", ""].join("\n");
}

const EPISODES = "# ตอนที่ทำแล้ว\n\n| วันที่ | โหมด | ชื่อ | เรื่องย่อ | ตัวละคร | ไฟล์ |\n|---|---|---|---|---|---|\n";

export function writeProjectFiles(projectDir, bible, opts = {}) {
  const { selected = {}, plates = {} } = opts;
  const slug = opts.slug ?? basename(projectDir);
  const lang = opts.lang ?? bible.lang;
  const aspect = opts.aspect ?? "9:16";
  const costDir = join(projectDir, ".vf");
  const usdThb = Number(process.env.VF_USD_THB) || 33.5;
  const costText = renderCostTable(summarize(readCosts(costDir)), usdThb);

  mkdirSync(projectDir, { recursive: true });
  writeJsonAtomic(join(projectDir, "project.json"), {
    ...bible, slug, aspect, lang, created_at: opts.created_at ?? new Date().toISOString(), version: 1,
  });

  const mdFile = join(projectDir, "PROJECT.md");
  let md = existsSync(mdFile) ? readFileSync(mdFile, "utf8") : projectMd(bible);
  md = under(md, "## ตัวละคร", "characters", charactersTable(bible));
  md = under(md, "## สถานที่", "places", placesTable(bible));
  md = under(md, "## แผนที่ไฟล์", "files", fileMap());
  md = under(md, "## ต้นทุนสะสม", "cost", costText);
  writeFileSync(mdFile, md);

  for (const c of bible.characters) {
    const d = join(projectDir, "characters", c.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "CHARACTER.md"), characterMd(c, bible));
    const { tts_voice, voice_description, ...rest } = c;
    const ref = selected[c.id] ? `ref/${basename(selected[c.id])}` : undefined;
    writeJsonAtomic(join(d, "character.json"), { ...rest, voice: { tts_voice, description: voice_description }, ...(ref ? { ref } : {}) });
  }
  for (const p of bible.places) {
    const d = join(projectDir, "places", p.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "PLACE.md"), placeMd(p));
    const plate = plates[p.id] ? `plates/${basename(plates[p.id])}` : undefined;
    writeJsonAtomic(join(d, "place.json"), { ...p, ...(plate ? { plate } : {}) });
  }
  const ep = join(projectDir, "EPISODES.md");
  if (!existsSync(ep)) writeFileSync(ep, EPISODES);
}
