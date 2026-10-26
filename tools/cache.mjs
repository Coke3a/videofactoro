import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { VfError, EXIT } from "./out.mjs";
import { writeJsonAtomic, readJson } from "./state.mjs";

export const TH_WORDS = {
  หมา: "dog", แมว: "cat", หนู: "mouse", กระโดด: "jump", วิ่ง: "run", นั่ง: "sit",
  ตกใจ: "surprised", หัวเราะ: "laugh", ร้องไห้: "cry", โกรธ: "angry", ดีใจ: "happy",
  เศร้า: "sad", ห้อง: "room", บ้าน: "house", ครัว: "kitchen", สวน: "garden",
  กลางคืน: "night", ฝน: "rain", ทะเล: "sea", ป่า: "forest",
};

const sha = (data) => createHash("sha256").update(data).digest("hex");
export const sha256File = (file) => sha(readFileSync(file));

export function cacheKey({ model, prompt, refs = [], aspect, resolution, seed }) {
  return sha(JSON.stringify({ model, prompt, refs: refs.map(sha256File), aspect, resolution, seed }));
}

const indexFile = (dir) => join(dir, "library", "index.json");

export function libLoad(projectDir) {
  return readJson(indexFile(projectDir), { entries: [] });
}

export function libFindByKey(lib, key) {
  return lib.entries.find((e) => e.key === key);
}

export function libAdd(projectDir, entry, bytes, ext) {
  const lib = libLoad(projectDir);
  if (lib.entries.some((e) => e.id === entry.id)) {
    throw new VfError(EXIT.USAGE, `มี entry id "${entry.id}" ในคลังแล้ว`);
  }
  const blob = `library/blobs/${sha(bytes).slice(0, 12)}.${ext}`;
  mkdirSync(join(projectDir, "library", "blobs"), { recursive: true });
  writeFileSync(join(projectDir, blob), bytes);
  const saved = { ...entry, blob, created_at: new Date().toISOString() };
  lib.entries.push(saved);
  writeJsonAtomic(indexFile(projectDir), lib);
  return saved;
}

export function libUpdate(projectDir, id, patch) {
  const lib = libLoad(projectDir);
  const i = lib.entries.findIndex((e) => e.id === id);
  if (i < 0) throw new VfError(EXIT.USAGE, `ไม่พบ entry id "${id}" ในคลัง`);
  const cur = lib.entries[i];
  lib.entries[i] = { ...cur, ...patch, id: cur.id, blob: cur.blob, created_at: cur.created_at };
  writeJsonAtomic(indexFile(projectDir), lib);
  return lib.entries[i];
}

export function libSearch(lib, terms, { kind, character, place, status } = {}) {
  const ts = terms.map((t) => String(t).toLowerCase()).map((t) => TH_WORDS[t] ?? t);
  const out = [];
  for (const entry of lib.entries) {
    if (kind && entry.kind !== kind) continue;
    if (character && !(entry.characters ?? []).includes(character)) continue;
    if (place && entry.place !== place) continue;
    if (status && entry.status !== status) continue;
    const tags = (entry.tags ?? []).map((t) => String(t).toLowerCase());
    const need = String(entry.need ?? "").toLowerCase();
    let score = 0;
    for (const t of ts) {
      for (const tag of tags) {
        if (tag === t) {
          score += 3;
          const p = entry.tag_p?.[tag];
          if (typeof p === "number") score += 3 * p;
        } else if (tag.includes(t) || t.includes(tag)) score += 1.5;
      }
      if (need.includes(t)) score += 1;
    }
    if (entry.status === "rejected") score -= 2;
    if (score > 0) out.push({ entry, score });
  }
  return out.sort((a, b) => b.score - a.score);
}
