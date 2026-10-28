import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse, VfError } from "./out.mjs";
import { resolveProject } from "./paths.mjs";
import { mediaInfo } from "./audio.mjs";
import { addTrack, libraryDir } from "./music-lib.mjs";

const OPTIONS = { prompt: { type: "string" }, "made-for": { type: "string" } };

// นำเพลงที่มีอยู่แล้ว (ไม่มีเสียงร้อง) เข้าคลังกลาง: vf music add <project> <file.mp3> --prompt "แนว อารมณ์ เครื่องดนตรี BPM"
export async function main(argv) {
  const { values, positionals } = parse(argv, OPTIONS);
  const [project, file] = positionals;
  const prompt = values.prompt?.trim();
  if (!file || !prompt) throw new VfError("USAGE", 'ใช้: vf music add <project> <file.mp3> --prompt "แนว อารมณ์ เครื่องดนตรี BPM" [--made-for "..."]');
  const src = resolve(file);
  if (!existsSync(src)) throw new VfError("USAGE", `ไม่พบไฟล์: ${src}`);
  const { duration, hasAudio } = await mediaInfo(src);
  if (!hasAudio || !(duration > 0)) throw new VfError("USAGE", `ไฟล์นี้ไม่มีเสียง: ${src}`);
  const lib = libraryDir(resolveProject(project));
  const track = addTrack({ lib, src, prompt, seconds: Math.floor(duration), madeFor: values["made-for"]?.trim() || "-", source: "imported" });
  return { library: lib, track: { id: track.id, file: track.file, seconds: track.seconds } };
}
