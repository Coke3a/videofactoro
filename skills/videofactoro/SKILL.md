---
name: videofactoro
description: Drive the `vf` CLI (videofactoro) to make AI videos on Cloudflare Workers AI. It builds a story project (world, style, characters, places), then renders short single-shot clips with narration and music, without stopping to ask the user. Use when the user asks to make a video, clip, cartoon, short, character, place or story; to create or extend a videofactoro project; or mentions videofactoro / `vf`. Thai triggers too ("สร้าง project เรื่อง…", "ทำคลิป…", "เพิ่มตัวละคร…", "ทำวิดีโอ…").
metadata:
  version: 0.3.0
  repo: https://github.com/Coke3a/videofactoro
  entry: node bin/vf.mjs
---

# videofactoro (`vf`)

`vf` is a CLI built for agents. Every command prints exactly **one JSON object on stdout**, writes logs to stderr, and **never asks the user anything**. You are the director: you turn a one-line idea into a project bible, characters, places and clips, make the judgement calls yourself, and report what you decided and what it cost.

Run everything from the repo root as `node bin/vf.mjs <command>`. This document writes it as `vf ...` for short. The bare `vf` binary is not on PATH unless the user linked it.

This file is the map. Details live in `references/`:

| Need | Read |
|---|---|
| Every command, flag, default and output field | `references/commands.md` |
| Project folder layout, json files, PROJECT.md rules | `references/project.md` |
| Clip pipeline, prompt craft, narration and music, QA | `references/clip.md` |
| Long videos: `vf film` (AI video) and `vf motion` (motion-comic) | `references/longform.md` |
| Prices, measured costs, how to budget | `references/costs.md` |
| First-time setup, env vars, security rules | `references/setup.md` |
| Known failure patterns and what fixed them | `references/lessons.md` |

## 0. Pick your track

- **Fast track** (strong model, user gave a clear idea): read this file, run the standard flow below, and open a reference only when a step surprises you.
- **Step-by-step track** (smaller model, vague idea, or anything failed once): before every command, open the matching reference, run `--dry-run` first, and check each JSON result against the checklist in section 7 before moving on.

Whichever track you take, the iron rules below do not change.

## 1. Iron rules

1. **Create the project first** (`vf project create`) before adding any character, place or clip.
2. **Read before you act:** run `vf project show <slug>` and read `projects/<slug>/PROJECT.md` (see `references/project.md`) before every change.
3. **Never ask the user mid-run.** Decide from the prompt and these rules. If information is missing, pick a sensible value and list it under "Decided myself" in the final report.
4. **No copyrighted or real names** (cartoon characters, films, games, brands, celebrities) in any prompt. Describe a generic equivalent: "a chubby orange tabby cat", not the famous cartoon cat.
5. **Search the library before generating:** `vf asset find <slug> <terms...>` (Thai terms work). Reuse what fits.
6. **Never read, print or ask for secrets.** Do not open `.env`, `.dev.vars` or `cloudflare.json`. The user sets keys in their own Terminal with `bash tools/set-env.sh` and then runs `node bin/vf.mjs setup`. You never run setup for them while keys are missing.
7. **Edit PROJECT.md only outside `<!-- vf:auto:... -->` blocks.** The tool rewrites those blocks every time.
8. **Report cost every time.** Every result carries `cost.usd`. Sum it up in your final message.
9. **Draft first, HD last.** Clips render as cheap drafts by default. Use `--hd` only after the user has seen and approved a draft.

## 2. Task routing

| The user says… | Do |
|---|---|
| "make a video/story about X" (no project yet) | `vf project create` → `vf wait` → one `vf clip` draft → report |
| "add a character / place" | `vf asset find` first, then `vf character add` or `vf place add` → `vf wait` |
| "use my drawing/photo for this character" | `vf project create --image <name>=<path>` or `vf character add --image <path>` |
| "redo / change how X looks" | `vf character add <slug> --replace --id <id> --prompt "..."` (old images go to `ref/old-<stamp>/`) |
| "make a clip of X doing Y" | `vf clip <slug> --prompt "..."` (draft) → `vf wait` → inspect → report |
| "make it HD / final" | rerun the approved clip prompt with `--hd` |
| "longer AI video (30 s – 3 min)" | `vf film <slug> --prompt "..." --duration N` → `vf wait` (loop) |
| "motion graphics / Top 5 / countdown / explainer" | `vf motion <slug> --prompt "..." --duration N` → `vf wait` (loop) |
| "how much will it cost?" | add `--dry-run` to the command; it costs nothing |
| "what's going on / is it done?" | `vf status <slug>` or `vf wait <slug>` |
| a command exits 3 (CONFIG) | stop and hand the user the setup steps (section 4) |

## 3. Standard flow

```
vf doctor                                                          # env check, read-only; exit 3 = stop
vf project create --prompt "..." --name <ascii-slug> --dry-run     # plan + estimated USD, free
vf project create --prompt "..." --name <ascii-slug>               # returns {job, next}
vf wait <slug>                                                     # loop until status is done or failed
vf project show <slug>                                             # check the result
vf character add <slug> --prompt "..."                             # optional
vf place add <slug> --prompt "..."                                 # optional
vf clip <slug> --prompt "..." --dry-run                            # clip plan + price, free
vf clip <slug> --prompt "..."                                      # draft clip, returns {job, next}; then vf wait
```

- **Always pass `--name <ascii-slug>`** (a-z, 0-9, `-`). A pure-Thai prompt without `--name` gets `project-<8 hex>`. The same prompt always maps to the same slug, so rerunning a command continues it instead of starting over.
- `project create` options: `--lang` (default `en`), `--aspect 9:16|16:9|1:1` (default `9:16`), `--max-rerolls 0-5` (default 2), `--image <character-name>=<path>` (repeatable).
- `--dry-run` works on `project create`, `character add`, `place add`, `clip`, `film` and `motion`.
- `vf status <slug>` lists the latest jobs.

## 4. Long jobs: job and wait

`project create`, `character add`, `place add`, `clip`, `film` and `motion` return `{job, next}` at once (unless you pass `--foreground`), and the work runs in the background.

1. `vf wait <slug> [job-id]` blocks for at most 540 seconds (change with `--timeout <sec>`). If your shell tool kills commands sooner (many agent sandboxes cap a command at 120–180 s), pass a smaller `--timeout`, for example `--timeout 150`.
2. If it times out while the job is still going (`status:"running"`), call `vf wait` again. **Loop until status is `done` or `failed`.**
3. A project runs one job at a time. Starting a second one gives USAGE (exit 2). Run `vf wait` on the current job until it finishes.
4. **A failed job still makes `vf wait` exit 0.** The JSON has `status: "failed"` and `error:{code,message}`. Look up `error.code` in the table below exactly as you would an exit code. Never judge by the exit code alone.
5. A failed job carries `resume` (the original command, already quoted). A failed `--foreground` command carries the same thing in `error.details.resume`. Rerunning it continues from where it stopped and does not pay twice for finished steps. `resume` starts with `vf`; when you run it, replace `vf` with `node bin/vf.mjs` and keep the rest as is.
6. If `error.message` starts with "worker หยุดกลางทาง" (Thai for "worker stopped mid-way"; code INTERNAL), the background worker died (machine slept or the process was killed). Follow the INTERNAL row.

Tool messages are in Thai. Read them anyway; the code and the table are what you act on.

### Results and exit codes

stdout is always one JSON object: `{ok:true,...}` or `{ok:false,error:{code,message,details}}`. Use this table both for a command's exit code and for `error.code` of a `failed` job.

| exit | code | What to do |
|---|---|---|
| 0 | ok | Go to the next step (`next` suggests commands). For `vf wait`, also check `status`. |
| 2 | USAGE | Read `error.message` first and fix what it says (bad argument, unknown project, a job is still running → `vf wait` it out). **Do not retry without reading the message.** |
| 3 | CONFIG | Env, token or credits problem. **Stop and report to the user; never retry.** The user runs, in their own Terminal: `bash tools/set-env.sh` then `node bin/vf.mjs setup` (that is `vf setup`; the user runs it, not you). |
| 4 | BLOCKED | Content filter. Rewrite the prompt to be more generic and milder (no protected names), then try again, **at most 2 retries**. Still blocked = stop and report. |
| 5 | PROVIDER | Provider outage or timeout. Run `resume` (or `error.details.resume`), **at most 2 retries**. Still failing = stop and report. |
| 1 | INTERNAL | Tool bug or dead worker. Run `resume` (or `error.details.resume`), **at most 2 retries**. Still failing = stop and report the error message as it is. |

## 5. Video mode

`vf clip <slug> --prompt "..."` makes one single-shot clip (5–20 s) from the project's characters and places. Full details are in `references/clip.md`.

- Pipeline: an LLM plans the shot (picks ≤3 characters and a place, writes the first-frame prompt, a timed video prompt, narration and a music brief) → first keyframe from character refs + place plate (QA-gated, rerolled up to `--max-rerolls`) → `flux-3-video` image-to-video with diegetic sound → video QA (report only) → narration (Gemini TTS, only if the project has a narrator) → music (ElevenLabs, auto-gated by QA) → ffmpeg mix.
- **Default is draft** (~$0.06 per clip for the video step). Add `--hd` only once the user likes the draft. `--duration 5-20`; `--id <id>` makes another clip from the same prompt.
- Audio flags: `--no-narration`; `--music` forces music on, `--no-music` forces it off (not both).
- Output: `renders/<clip-id>.mp4` (final mix), plus `clips/<clip-id>/` (`plan.json`, `keyframe.jpg`, `clip.mp4` raw video, `qa.json`, `narration.wav`, `music.mp3`) and a row in `EPISODES.md`.
- Rerunning a prompt that already finished = USAGE (pass a new `--id`). Rerunning after a crash continues, and a video request that was already sent is followed up, never paid twice.
- `result.clip.warnings` lists QA concerns. The video QA is a weak signal: camera moves and cuts often score low on "consistent" and "follows prompt" while the clip looks fine. **Look at frames yourself** before you call a clip bad (see `references/clip.md`, "Inspecting a clip").

### Long videos (20–180 s): `vf film` and `vf motion`

Both take `--prompt`, `--duration 20-180` (default 60), `--no-narration`, `--no-music`, `--id`, `--max-rerolls` (default 1), `--foreground` and `--dry-run`, and run as a job (`vf wait`). Details are in `references/longform.md`.

- `vf film <slug> --prompt "..." --duration 90`: a **generative AI** short film. The LLM writes a shot list (5–10 s shots, hook → build → payoff), and each shot gets a keyframe and a flux-3-video clip (3 shots at a time). The shots are joined, with one narration track and one music bed over the whole film. Draft by default, `--hd` for final. About $0.12–0.15 per draft shot, so 90 s ≈ $1.5–2, taking 10–20 min.
- `vf motion <slug> --prompt "..." --duration 90`: a **motion-comic** with no video model. Each scene is an AI still of the characters, animated by ffmpeg (zoom, pan, shake, bounce), with text overlays (title, rank cards like `#3`, captions, comic sound words), narration and music. Good for countdowns ("Top 5…"), stories and explainers. About $0.03 per scene, so 90 s ≈ $0.6–0.8. Text needs ffmpeg with libass; without it you get a warning and a clip with no text.
- Output: `renders/<id>.mp4`; working files are in `films/<id>/` or `motions/<id>/`.

Pick by what the user asked for: "AI video / realistic motion" → film; "motion graphics / ranking / countdown / cheap and fast" → motion; a single moment → clip.

## 6. Director rules (what makes clips good)

- **One clip = one beat.** A single clear action with a setup and a payoff ("tiptoes past, grabs cookie, freezes when the cat stirs"). Several events in 6 seconds turn to mush.
- **Name characters by their project id or role**, and describe actions and camera. The tool adds each character's locked `look` and the style; do not restate the look in other words.
- **Sound in the video prompt is diegetic only** (footsteps, purring, plates clinking). Music is added afterwards; asking the video model for music produces cheesy stingers.
- **Narration is short:** 1–2 sentences that add meaning and do not describe what is on screen. The budget is about 2.2 words/s (11 chars/s for Thai/CJK) minus a second.
- **Keep text out of the frame.** Signs, labels and logos come out garbled. Ask for none.
- **Prefer 5–8 s** for a single beat. Longer clips drift more.

### Anti-patterns

| Anti-pattern | Why it hurts | Do instead |
|---|---|---|
| Adding characters before `project create` | No bible, so no style or world | Create the project first |
| Retrying a CONFIG error | Keys are wrong; retrying burns time | Stop and give the user the setup steps |
| Going straight to `--hd` | ~3× the price for a clip nobody approved | Draft, show, then HD |
| Famous names in prompts | BLOCKED, or a legal problem | A generic description |
| Treating a video QA warning as failure | False negatives on camera moves | Inspect frames, then decide |
| Rerunning a crashed clip with a new `--id` | Pays again for finished steps | Run `resume` |
| Editing inside `vf:auto` blocks or the json files by hand | Overwritten, or breaks the state | Edit outside the blocks; use `--replace` |
| Asking the user to paste API keys | Secrets in chat | `bash tools/set-env.sh` in their Terminal |

## 7. Acceptance checklist (before you report)

- [ ] Every command ended `ok:true`, or a failed job was handled by the table in section 4.
- [ ] `vf project show <slug>` lists the expected characters and places, each with an image file that exists.
- [ ] For clips: `renders/<clip-id>.mp4` exists, you looked at 3–6 frames (and listened, or checked there is an audio stream), and `warnings` are explained.
- [ ] No secret, token or signed URL appears in anything you wrote.
- [ ] The cost table adds up to the sum of `cost.usd`.

## 8. Final report (in the user's language)

```
Done: <title> (project: <slug>)
Characters:
- <id> <name>: projects/<slug>/characters/<id>/ref/main.png
Places:
- <id>: projects/<slug>/places/<id>/plates/main.jpg
Clips:
- <clip-id> (<seconds>s, draft|hd): projects/<slug>/renders/<clip-id>.mp4 (narration: yes/no, music: yes/no)
Decided myself: <values you chose because the prompt did not say>
Cost (estimated):
| Step | Runs | USD |
| ... |
| Total | | $X.XX |
```

Take the numbers from `cost.usd` in each result and from the cumulative cost table in PROJECT.md. Say that the agent's own LLM usage is not included, and that video, TTS and Haiku prices are still unverified estimates.

## 9. Feedback loop

When something fails in a new way, or a fix works, add a dated entry to `references/lessons.md` (symptom → cause → fix). Read it before you debug. Project-specific lessons (a character that keeps losing its hat) go in that project's PROJECT.md under the story rules, outside the auto blocks.
