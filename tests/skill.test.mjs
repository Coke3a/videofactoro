import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillPath = join(root, "skills/videofactoro/SKILL.md");
const skill = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";

function commandMap() {
  const src = readFileSync(join(root, "bin/vf.mjs"), "utf8");
  const body = src.match(/const COMMANDS = \{([\s\S]*?)\n\};/)[1];
  return [...body.matchAll(/^\s*"?([a-z ]+)"?\s*:/gm)].map((m) => m[1]);
}

test("SKILL.md มี frontmatter name และ description", () => {
  const m = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "ต้องมี frontmatter");
  assert.match(m[1], /^name: videofactoro$/m);
  assert.match(m[1], /^description: .{40,}/m);
});

test("ทุก vf <command> ใน SKILL.md มีอยู่จริงใน bin/vf.mjs", () => {
  const known = commandMap();
  assert.ok(known.includes("project create"));
  const planned = new Set(["clip", "film", "motion"]);
  const seen = new Set();
  for (const line of skill.split("\n")) {
    for (const m of line.matchAll(/\bvf\s+([a-z]+)(?:\s+([a-z]+))?/g)) {
      const two = m[2] ? `${m[1]} ${m[2]}` : null;
      const cmd = two && known.includes(two) ? two : m[1];
      if (known.includes(cmd)) {
        seen.add(cmd);
        continue;
      }
      assert.ok(planned.has(cmd) && line.includes("ยังไม่มี"), `คำสั่งที่ไม่มีจริง: vf ${cmd} (บรรทัด: ${line})`);
    }
  }
  for (const c of ["doctor", "setup", "project create", "project show", "character add", "place add", "asset find", "wait", "status"]) {
    assert.ok(seen.has(c), `SKILL.md ควรอธิบาย vf ${c}`);
  }
});

test("symlink .claude/skills/videofactoro ชี้ถึง skills/videofactoro", () => {
  const link = join(root, ".claude/skills/videofactoro");
  assert.ok(existsSync(join(link, "SKILL.md")));
  assert.equal(realpathSync(link), realpathSync(join(root, "skills/videofactoro")));
});

test("SKILL.md: failed job = exit 0 + status failed, ใช้ error.code, ลองซ้ำสูงสุด 2 ครั้ง, CONFIG/USAGE ห้ามลองซ้ำ", () => {
  const sec = skill.slice(skill.indexOf("## งานยาว"), skill.indexOf("## โหมดวิดีโอ"));
  assert.match(sec, /exit 0/);
  assert.match(sec, /status:\s*"failed"/);
  assert.match(sec, /error\.code/);
  assert.match(sec, /`resume`/);
  assert.match(sec, /สูงสุด 2 ครั้ง/);
  assert.ok((sec.match(/สูงสุด 2 ครั้ง/g) ?? []).length >= 2, "ทั้ง BLOCKED และ PROVIDER/INTERNAL ต้องมีเพดาน 2 ครั้ง");
  assert.match(sec, /\| 3 \| CONFIG \|[^\n]*ห้ามลองซ้ำ[^\n]*vf setup/);
  assert.match(sec, /\| 2 \| USAGE \|[^\n]*ห้ามลองซ้ำแบบไม่ดู/);
  assert.match(sec, /worker หยุดกลางทาง/);
});
