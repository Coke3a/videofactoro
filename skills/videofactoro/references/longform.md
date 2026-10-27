# Long videos: `vf film` and `vf motion`

Both make a 20–180 s video from an existing project's characters and places, run as a background job, and resume without paying twice.

| | `vf film` | `vf motion` |
|---|---|---|
| Look | Generative AI video: real motion, acting, scene sound | Motion-comic: AI stills + camera moves + bold text |
| Unit | shot, 5–10 s, mostly 8–10 s (one flux-3-video clip each) | scene, 3–8 s (one still each) |
| Text on screen | none | title, rank cards, captions, comic sound words |
| Cost, 90 s | ≈ $1.5–2 draft (13 shots) · HD ≈ +$1.4 | ≈ $0.6–0.8 (18 scenes) |
| Time, 90 s | 10–20 min (3 shots at a time) | 5–12 min (CPU-bound ffmpeg) |
| Best for | skits, stories, "AI video" channels | Top-N countdowns, explainers, quick daily content |

## Common flags

`--prompt` (required), `--duration 20-180` (default 60), `--no-narration`, `--no-music`, `--id <id>`, `--max-rerolls 0-5` (default 2, per image), `--foreground`, `--dry-run`. `vf film` also takes `--hd`; `vf motion` also takes `--no-reuse` (see Reuse below).

Narration is on only when the project has a narrator (`project.json` → `narrator: true`). Music is always on unless you pass `--no-music`: one instrumental bed for the whole video, ducked under the voice.

## `vf film` pipeline

1. **plan** (LLM): title, summary, `music_prompt`, and `shots[]`: `{duration, characters, place, first_frame_prompt, video_prompt, narration}`. Validation: the shot count fits the length, each shot is 5–10 s, the total is within ±10 %, ids exist, narration fits each shot, no risky names.
2. **per shot** (3 at a time): keyframe (refs + plate, QA) → video (i2v, diegetic sound, request id saved before polling) → narration (TTS) → normalize (720×1280 @24 fps for 9:16, stereo 48 kHz).
3. **concat** → `films/<id>/film-raw.mp4`.
4. **narration track**: each line placed at its shot's start (+0.3 s), sped up to 1.3× if too long.
5. **music** (ElevenLabs; film + 1 s when that is ≤ 30 s, otherwise one 30 s loopable track crossfaded to length, saved as `music-loop.mp3` → `music.mp3`) → **mix** → `renders/<id>.mp4`.

Video QA is not run per shot (it is a weak signal and slow). Inspect a contact sheet instead (see `clip.md`).

## `vf motion` pipeline

1. **plan** (LLM): `scenes[]`: `{duration, characters, place, image_prompt, move, card, caption, sfx_word, narration}`. `move` ∈ `zoom_in, zoom_out, pan_left, pan_right, shake, bounce`. `card` and `sfx_word` are ≤ 14 characters; `caption` is ≤ 60.
2. **per scene** (3 at a time): still image (refs + plate, keyframe QA) and narration.
3. **render** each scene with ffmpeg zoompan (one at a time) → **concat**.
4. **text** (ASS subtitles via libass): the title over the first scene, a card popping in at each scene start, the caption at the bottom for the whole scene, and the sound word popping at 40 % of the scene. Fonts: `DejaVu Sans`, or `Loma` for Thai; override with `VF_FONT`.
5. **narration track** + **music** → **mix** → `renders/<id>.mp4`.

## Writing the prompt

Say the format, the beats, and the tone. The planner handles the rest.

- Film: "Biscuit tries to bake a birthday cake for Marmalade; every step goes wrong; ending: the cat loves the burnt one."
- Motion: "Top 5 times Biscuit the dog panicked over nothing, countdown from #5 to #1, punchy and silly."

## Reuse (motion)

Before making a scene's still, `vf motion` checks `library/index.json` for up to 3 old stills/keyframes with the same character set, the same place and the same aspect whose prompt shares at least 30 % of the scene's content words (character descriptions and the style prompt don't count). clef checks each with the keyframe questions; it is used only if the characters match and `fits_shot` ≥ 0.75. Images that failed QA earlier (`status: rejected`), images made in the same video, and images already used 3 times are skipped. A reused still costs only the clef check (~$0.0002) and is logged as a $0 `still` row with `reused: <entry id>`. The library entry's `used_in` records where it went.

## Resume and repeats

- The key is `--id`, or a hash of the inputs; state lives in `.vf/film-<key>-state.json` / `.vf/motion-<key>-state.json`.
- A crash or a dead worker: run `resume` from `vf wait`. Finished shots/scenes are skipped; in-flight videos are polled, not re-bought.
- The same prompt after success = USAGE. Use `--id` for another take.
- A film shot whose video is blocked is retried twice inside the tool (softer prompt, then a new keyframe). If the job still fails BLOCKED, edit that shot's `video_prompt` (and/or `first_frame_prompt`) in `films/<film-id>/plan.json` to something milder, then run `resume`. Finished shots stay as they are; only unfinished shots read the edited prompts. Keep the number of shots the same. Never edit `.vf/*-state.json` by hand.

## Requirements

`ffmpeg` with `libx264`; for motion text, ffmpeg built with `libass` plus fonts (`fonts-dejavu-core`, `fonts-thai-tlwg` for Thai). `vf doctor` checks ffmpeg; `vf motion --dry-run` says whether libass is present.
