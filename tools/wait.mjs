import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse, VfError } from "./out.mjs";
import { listJobIds, waitJob } from "./jobs.mjs";

export function jobRootOf(project) {
  if (!project) throw new VfError("USAGE", "ต้องระบุ <project>");
  const root = join(project, ".jobs");
  if (!existsSync(root)) throw new VfError("USAGE", `ไม่พบโฟลเดอร์ .jobs ใน: ${project}`);
  return root;
}

export async function main(argv) {
  const { values, positionals } = parse(argv, { timeout: { type: "string" } });
  const root = jobRootOf(positionals[0]);
  const ids = listJobIds(root);
  const id = positionals[1] ?? ids.at(-1);
  if (!id || !ids.includes(id)) throw new VfError("USAGE", `ไม่พบ job: ${id ?? "(ไม่มี job)"}`);
  const timeout = values.timeout === undefined ? 540 : Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout < 0) throw new VfError("USAGE", "--timeout ต้องเป็นตัวเลขวินาที");
  return await waitJob(join(root, id), timeout);
}
