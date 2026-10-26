import { join } from "node:path";
import { parse } from "./out.mjs";
import { resolveProject } from "./paths.mjs";
import { listJobIds, jobStatus, jobRootOf } from "./jobs.mjs";

export async function main(argv) {
  const { positionals } = parse(argv, {});
  const root = jobRootOf(resolveProject(positionals[0]));
  const jobs = listJobIds(root)
    .slice(-10)
    .reverse()
    .map((id) => {
      const { log_tail, ...s } = jobStatus(join(root, id));
      return s;
    });
  return { jobs };
}
