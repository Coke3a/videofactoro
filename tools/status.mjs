import { join } from "node:path";
import { parse } from "./out.mjs";
import { listJobIds, jobStatus, jobRootOf } from "./jobs.mjs";

export async function main(argv) {
  const { positionals } = parse(argv, {});
  const root = jobRootOf(positionals[0]);
  const jobs = listJobIds(root)
    .slice(-10)
    .reverse()
    .map((id) => {
      const { log_tail, ...s } = jobStatus(join(root, id));
      return s;
    });
  return { jobs };
}
