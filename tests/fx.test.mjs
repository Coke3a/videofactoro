import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SFX_KINDS, sfxSynthArgs } from "../tools/fx.mjs";
import { ffmpeg } from "../tools/assemble.mjs";

const seconds = (f) => Number(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", f], { encoding: "utf8" })).format.duration);

test("SFX_KINDS ครบทุกชนิดที่แผนเลือกได้", () => {
  for (const k of ["whirr", "pop", "whoosh", "boing", "bang", "ding"]) assert.ok(SFX_KINDS.includes(k), k);
});

test("sfx ใหม่สังเคราะห์ได้จริงด้วย ffmpeg", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-sfx-"));
  for (const [kind, lo, hi] of [["whirr", 1, 1.8], ["pop", 0.08, 0.3], ["bang", 0.3, 0.9]]) {
    const out = path.join(dir, `${kind}.wav`);
    await ffmpeg(sfxSynthArgs(kind, out), kind);
    const d = seconds(out);
    assert.ok(d > lo && d < hi, `${kind} ยาว ${d}`);
  }
});
