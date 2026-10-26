import { parseArgs } from "node:util";
import { finishJob } from "../../tools/jobs.mjs";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { foreground: { type: "boolean" }, "job-dir": { type: "string" } },
  allowPositionals: true,
  strict: false,
});
await new Promise((r) => setTimeout(r, 1000));
const result = { x: 1 };
if (values["job-dir"]) finishJob(values["job-dir"], { result });
process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
