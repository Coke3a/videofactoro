import { join } from "node:path";
import { parse, VfError } from "./out.mjs";
import { listJobIds, waitJob, jobRootOf } from "./jobs.mjs";

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
