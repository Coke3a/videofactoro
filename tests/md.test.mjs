import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceAuto } from "../tools/md.mjs";

const doc = "# หัว\nมือเขียน A\n<!-- vf:auto:chars -->\nเก่า\n<!-- /vf:auto:chars -->\nมือเขียน B\n<!-- vf:auto:cost -->\nต้นทุนเก่า\n<!-- /vf:auto:cost -->\nท้าย\n";

test("replaceAuto แทนเฉพาะบล็อก auto ไม่แตะข้อความอื่น", () => {
  const out = replaceAuto(doc, "chars", "ใหม่\nสองบรรทัด");
  assert.equal(
    out,
    "# หัว\nมือเขียน A\n<!-- vf:auto:chars -->\nใหม่\nสองบรรทัด\n<!-- /vf:auto:chars -->\nมือเขียน B\n<!-- vf:auto:cost -->\nต้นทุนเก่า\n<!-- /vf:auto:cost -->\nท้าย\n",
  );
});

test("replaceAuto ไม่มี marker: ต่อท้ายพร้อม marker", () => {
  const out = replaceAuto("# หัว\nข้อความ\n", "files", "แผนที่");
  assert.equal(out, "# หัว\nข้อความ\n\n<!-- vf:auto:files -->\nแผนที่\n<!-- /vf:auto:files -->\n");
});

test("replaceAuto รันซ้ำได้ผลเท่าเดิม และเนื้อหามี $& ไม่ถูกตีความ", () => {
  const once = replaceAuto(doc, "cost", "$& $1 ราคา");
  assert.ok(once.includes("<!-- vf:auto:cost -->\n$& $1 ราคา\n<!-- /vf:auto:cost -->"));
  assert.equal(replaceAuto(once, "cost", "$& $1 ราคา"), once);
});
