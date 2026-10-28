import { join } from "node:path";
import { parse } from "./out.mjs";
import { resolveProject } from "./paths.mjs";
import { libraryDir, loadLibrary } from "./music-lib.mjs";

// คลังเพลงกลางอยู่ข้าง project (โฟลเดอร์ _music ใน root ของ project) จึงระบุ project ตัวไหนก็ได้
export async function main(argv) {
  const { positionals } = parse(argv, {});
  const lib = libraryDir(resolveProject(positionals[0]));
  const { tracks } = loadLibrary(lib);
  return {
    library: lib, guide: join(lib, "MUSIC.md"),
    tracks: tracks.map((t) => ({ id: t.id, seconds: t.seconds, prompt: t.prompt, made_for: t.made_for, uses: t.uses?.length ?? 0 })),
  };
}
