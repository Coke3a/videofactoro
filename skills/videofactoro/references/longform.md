# Long videos: `vf film` and `vf motion`

Both make a 20–180 s video from an existing project's characters and places, run as a background job, and resume without paying twice.

| | `vf film` | `vf motion` |
|---|---|---|
| Look | Generative AI video: real motion, acting, scene sound | Cartoon: reusable cut-out pose sprites animated by HyperFrames + GSAP on a place plate, with props, camera, stamps, screen shake, captions |
| Unit | shot, 5–20 s, mostly 15–20 s with 2–3 timed beats (one flux-3-video clip each) | scene with several beats; characters change pose and move between stage spots |
| Needs first | characters and places | `vf character poses` for every character (once), a place with a plate; 9:16 only |
| Cost, 90 s | ≈ $1.5–2 draft (13 shots) · HD ≈ +$1.4 | ≈ $0.06–0.11 per 60 s clip measured (LLM incl. retries, TTS, clef) + music ($0 from library, $0.2275 new track) |
| Time | 10–20 min for 90 s (3 shots at a time) | render ≈ 3.5× clip length on 2 vCPU, one render per project at a time |
| Best for | skits, stories, "AI video" channels | cheap cartoon gags and stories with our own characters |

## Common flags

`--prompt` (required), `--duration 20-180` (default 60), `--no-narration`, `--no-music`, `--id <id>`, `--foreground`, `--dry-run`. In `vf motion`, `--id` becomes the motion id and the render name `renders/<id>.mp4` (film derives the name from title + key). `vf film` also takes `--hd` and `--max-rerolls 0-5` (default 2, per image). `vf motion` accepts `--no-reuse` and `--max-rerolls` only for old callers: both are ignored and a warning is returned (deprecated).

Narration is on only when the project has a narrator (`project.json` → `narrator: true`) and you did not pass `--no-narration`; this holds for film and motion. Music is always on unless you pass `--no-music`: one instrumental bed for the whole video, ducked under the voice.

## `vf film` pipeline

1. **plan** (LLM): title, summary, `music_prompt`, and `shots[]`: `{duration, characters, place, first_frame_prompt, video_prompt, narration}`. Validation: the shot count fits the length, each shot is 5–10 s, the total is within ±10 %, ids exist, narration fits each shot, no risky names.
2. **per shot** (3 at a time): keyframe (refs + plate, QA) → video (i2v, diegetic sound, request id saved before polling) → narration (TTS) → normalize (720×1280 @24 fps for 9:16, stereo 48 kHz).
3. **concat** → `films/<id>/film-raw.mp4`.
4. **narration track**: each line placed at its shot's start (+0.3 s), sped up to 1.3× if too long.
5. **music** (shared library `_music/`: clef-omni listens to tracks at least as long as the video and reuses the best one scoring ≥ 0.6; otherwise ElevenLabs makes a new track of max(video + 1 s, 90 s), which is added to the library and `_music/MUSIC.md`; copied to `music.mp3`) → **mix** (music trimmed to the video) → `renders/<id>.mp4`.

Video QA is not run per shot (it is a weak signal and slow). Inspect a contact sheet instead (see `clip.md`).

## `vf motion` setup (before the first run)

1. `vf character poses <project> <character>`: once per character, a background job (`vf wait`). It draws 6 poses (idle, happy, scared, sad, curious, run), cuts each out to a transparent png and makes a mouth-open "talk" twin. About $0.04 per character. `--poses idle,happy` makes a subset, `--replace` redoes the whole set, `--replace --poses happy,run` redoes only those poses and keeps the rest (replaced files are kept in `poses-old-*`). Talk twins are checked against their pose so the eyes do not flicker with the mouth. Files: `characters/<id>/poses/` (`poses.json`, `<pose>.png`, `<pose>-talk.png`).
2. `vf prop add <project> --prompt "a red rubber ball" [--id ball]`: optional, about $0.001 per prop, files in `props/<id>/`. Default id = first 3 words of the prompt, slugified; a prompt with no Latin words (Thai) needs `--id` (a-z, 0-9, `-`). A duplicate id = USAGE. Props named by the story plan are created automatically during `vf motion`.
3. Stage spots: where characters may stand on a place. Computed once per place by clef (cheap) and cached in `places/<id>/place.json`; never asked again.

`vf motion` fails fast with USAGE, before any paid call, when: the project has no character, no place with a plate, the project is not 9:16, or any character of the project has no poses (the message names the `vf character poses` command to run).

## `vf motion` pipeline

The total length of the scenes must be within ±10 % of `--duration` (the LLM is asked to rewrite otherwise). Motion line budget: 2.68 words/s, max 13 words per line.

1. **story** (LLM) from the prompt and the cast (characters with their poses, places, existing props) → **props** missing ones are made → **stage** spots per place.
2. **scenes** (LLM): scenes with beats that use only existing pose names, stage spots, props and sound effects. Lines of dialogue are spoken by the character's own voice, narration by the narrator voice.
3. **tts** for every line (3 at a time), silence trimmed; the real speech length decides each scene's length and the mouth flaps.
4. **compose** `motions/<id>/hf/index.html` (HyperFrames + GSAP, 1080×1920 @ 30 fps) → **lint** (errors stop the job with INTERNAL; warnings go to `warnings`) → **check**: one snapshot per scene, clef looks for staging problems (a hit becomes a warning `ฉาก N: ...`).
5. **render** with HyperFrames (Chrome) → `video.mp4`, then narration track, music, synthesized sound effects and a -14 LUFS **mix** → `renders/<id>.mp4`.

`motions/<id>/plan.json` holds the plan (with `characters`, `title`, `summary`). A crash or a failed lint resumes from the saved plan without new LLM or TTS cost.

## Writing the prompt

Say the format, the beats, and the tone. The planner handles the rest.

- Film: "Biscuit tries to bake a birthday cake for Marmalade; every step goes wrong; ending: the cat loves the burnt one."
- Motion: "Biscuit the dog chases a ball, the cat watches, scared at first then happy; funny and short, 30 seconds."

## Resume and repeats

- The key is `--id`, or a hash of the inputs; state lives in `.vf/film-<key>-state.json` / `.vf/motion2-<key>-state.json`.
- A crash or a dead worker: run `resume` from `vf wait`. Finished shots/scenes are skipped; in-flight videos are polled, not re-bought.
- The same prompt after success = USAGE. Use `--id` for another take.
- A film shot whose video is blocked is retried twice inside the tool (softer prompt, then a new keyframe). If the job still fails BLOCKED, edit that shot's `video_prompt` (and/or `first_frame_prompt`) in `films/<film-id>/plan.json` to something milder, then run `resume`. Finished shots stay as they are; only unfinished shots read the edited prompts. Keep the number of shots the same. Never edit `.vf/*-state.json` by hand.

## Requirements

`ffmpeg` with `libx264`. Motion also needs `hyperframes` and `gsap` (pinned npm packages) and Chrome: `vf setup` runs `npm ci` and `hyperframes browser ensure`, and `vf doctor` checks them. Caption fonts: `fonts-dejavu-core`, `fonts-thai-tlwg` for Thai (override with `VF_HF_FONT=<font file>`); no font found = CONFIG. GSAP is under its own Standard License (see `NOTICE`), not MIT.
