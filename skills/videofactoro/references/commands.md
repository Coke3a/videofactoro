# Command reference

Run as `node bin/vf.mjs <command> [args]` from the repo root. Every command prints one JSON object on stdout (`{ok:true, ...}` or `{ok:false, error:{code, message, details}}`) and logs to stderr. Exit codes: 0 ok · 1 INTERNAL · 2 USAGE · 3 CONFIG · 4 BLOCKED · 5 PROVIDER.

Successful results usually carry `cost: {usd}` (the estimated spend of this command) and `next: [...]` (suggested follow-up commands).

`<project>` is a slug under `$VF_PROJECTS` or a path to a project folder. Ids are `^[a-z][a-z0-9-]{1,30}$`.

## Setup and health

### `vf doctor [--online]`
Read-only environment check: Node version, ffmpeg/ffprobe, required env vars present (never their values). `--online` also verifies the Cloudflare token. Exit 3 when a core variable is missing.

### `vf setup`
For the **user** to run after `bash tools/set-env.sh`. Checks the env, verifies the token online, and checks that AI Gateway credits work. Agents do not run it while keys are missing; they report exit 3 to the user instead.

## Project

### `vf project create --prompt "<idea>" [options]`
Builds a whole project from one prompt: a bible (title, world, style, palette, narrator, music style, story rules), 1–4 characters with reference images, and 1–3 places with background plates. Each image is QA-gated and rerolled on failure.

| Flag | Default | Meaning |
|---|---|---|
| `--name <slug>` | from the prompt | Project slug. Always pass an ASCII slug. |
| `--lang <code>` | `en` | Language of story text and narration (`th`, `en`, `ja`…). |
| `--aspect` | `9:16` | `9:16`, `16:9` or `1:1`. Fixed for the whole project. |
| `--image <name>=<path>` | none | Use the user's own image for a character (repeatable). |
| `--max-rerolls 0-5` | 2 | Extra attempts per image when QA rejects it. |
| `--foreground` | off | Run in this process instead of a background job. |
| `--dry-run` | off | Print the plan and estimated USD; no paid calls. |

Returns `{job, next}` (background) or the finished project (foreground). Takes about 3 minutes for 2 characters and 3 places.

### `vf project show <project>`
Summary JSON: `project`, `dir`, `title`, `logline`, `lang`, `aspect`, `narrator`, `characters[{id,name,role,ref,poses}]`, `places[...]`, episodes. Free.

## Characters and places

### `vf character add <project> --prompt "<description>" [options]`
Adds one character that fits the project's style and world.

| Flag | Meaning |
|---|---|
| `--id <id>` | Choose the id (otherwise derived from the name). |
| `--image <path>` | The user's own image(s) as reference, up to 4 (repeatable). The first becomes `ref/main.png`, the rest `ref/extra-<n>.png`. |
| `--replace --id <id>` | Replace an existing character; old images move to `ref/old-<stamp>/`. |
| `--foreground`, `--dry-run` | As above. |

### `vf place add <project> --prompt "<description>" [--id <id>] [--max-rerolls 0-5] [--foreground] [--dry-run]`
Adds one place with a background plate (no people or animals in it).

### `vf asset find <project> <terms...> [--kind <kind>] [--character <id>] [--limit N]`
Searches the project library (accepted and rejected images, tags, QA). Thai terms work. Default limit 10. Returns `results[{id, kind, file, score, tags, status, need}]`. Free.

## Video

### `vf clip <project> --prompt "<what happens>" [options]`
One single-shot clip with narration and music. See `clip.md` for the pipeline.

| Flag | Default | Meaning |
|---|---|---|
| `--duration 5-20` | the LLM chooses (usually 5–8) | Clip length in seconds. |
| `--hd` | off (draft) | Higher quality video, about 3× the video cost. Only after a draft is approved. |
| `--no-narration` | narration on if the project has a narrator | Skip TTS. |
| `--music` / `--no-music` | auto (QA decides) | Force music on or off. Not both. |
| `--id <id>` | from the prompt | Clip key; use a new id to make another clip from the same prompt. |
| `--max-rerolls 0-5` | 2 | Keyframe rerolls on QA reject. |
| `--foreground`, `--dry-run` | | As above. |

Result (`result` of the job): `clip: {id, title, duration, quality, characters, place, file, raw, keyframe, narration, music, warnings}`, `cost`, `next`.

## Jobs

### `vf wait <project> [job-id] [--timeout <sec>]`
Blocks until the job (default: latest) leaves `running` or the timeout passes (default 540 s). Returns `{id, status, command, label, log_tail, result?, error?, resume?}`. **Exit 0 even when `status` is `failed`.** Check `status` and `error.code`.

### `vf status <project>`
The last 10 jobs, newest first, without log tails. Free.

### `vf help`
Usage text.

### `vf film <project> --prompt "<story>" [--duration 20-180] [--hd] [options]`
A multi-shot generative AI video (mostly 15–20 s shots joined, one narration track, one music bed from the shared library). Options: `--duration` (default 60), `--hd`, `--no-narration`, `--no-music`, `--id`, `--max-rerolls` (default 2), `--foreground`, `--dry-run`. Result: `film: {id, title, seconds, shots, quality, file, dir, narration, music, music_track, warnings}` (`music_track: {id, reused, score}`). See `longform.md`.

### `vf motion <project> --prompt "<idea>" [--duration 20-180] [options]`
A cartoon with the project's characters: cut-out pose sprites animated by HyperFrames + GSAP on a place plate, with props, camera moves, captions, mouth flaps, narration, music and sound effects. No video model. 9:16 projects only. USAGE (before any paid call) until every character has poses (`vf character poses`), and when the project has no place with a plate. Options: `--duration` (default 60), `--no-narration`, `--no-music`, `--id`, `--foreground`, `--dry-run`. Narration follows the project `narrator` setting like film. `--no-reuse` and `--max-rerolls` are deprecated: accepted, ignored, with a warning. Result: `motion: {id, title, seconds, scenes, file, dir, narration, music, sfx, music_track, warnings}` (`reused_stills` is always 0 and `text` always true; kept only for old callers). Cost ≈ $0.02–0.03 plus music; render ≈ 3.5× clip length. See `longform.md`.

### `vf character poses <project> <character> [--poses idle,happy,...] [--replace]`
Makes the character's cut-out pose sprites and mouth-open talk twins (default set: idle, happy, scared, sad, curious, run), needed by `vf motion`. One background job per character, about $0.04. Existing poses = USAGE unless `--replace`: alone it redoes the whole set (the old set moves to `poses-old-*`); with `--poses happy,run` it redoes only those poses (only their files move to `poses-old-*`, the other poses stay untouched in `poses.json`). Each talk twin is QA'd against its pose (same eyes, brows and body; mouth open) and redrawn up to 2 times. Also `--foreground`, `--dry-run`. Result: `poses` (all names in the set), `warnings` for poses or talk twins (`<pose> (talk)`) that did not pass QA.

### `vf prop add <project> --prompt "<object>" [--id <id>]`
Makes a cut-out prop sprite for motion (about $0.001). Default id = first 3 words of the prompt, slugified; a prompt with no a-z0-9 words needs `--id`. Existing id = USAGE. Also `--foreground`, `--dry-run`. Props named by a motion plan are created automatically.
