# Project layout

Location: `$VF_PROJECTS` (default `./projects/` inside the repo, git-ignored). One folder per project.

```
projects/<slug>/
  PROJECT.md            Read this first: story, world, visual style, voice and mood, rules, file map, costs
  project.json          Machine-readable bible (all bible fields + slug, aspect, lang, created_at, version)
  EPISODES.md           Clips made so far (one row per clip, written by the tool)
  characters/<id>/      CHARACTER.md, character.json, ref/main.png (main reference image)
                        ref/extra-<n>.png (extra refs from character add --image) · ref/old-<stamp>/ (previous images after --replace)
  places/<id>/          PLACE.md, place.json, plates/main.jpg
  clips/<clip-id>/      plan.json, keyframe.jpg, clip.mp4 (raw video), narration.wav, music.mp3, qa.json
  renders/<clip-id>.mp4 Final clip with the audio mix
  library/              index.json + blobs/ (what `vf asset find` searches; rejected candidates live in library/blobs/ with their QA in the qa field)
  .vf/                  costs.jsonl (one row per paid call) + command state (create-state.json, character-<key>-state.json, place-<key>-state.json, clip-<key>-state.json)
  .jobs/<job-id>/       job.json, job.log, job.pid, heartbeat of a background job
```

The tool owns `.vf/` and `.jobs/`. Never edit or delete them while a job may still resume: they are how a crashed command continues without paying twice.

## PROJECT.md

Fixed sections: synopsis · world · visual style · voice and mood · characters · places · story rules · file map · cumulative cost. (The headings themselves are written in Thai.)

The parts the tool writes (character and place tables, file map, cost table) sit between markers:

```
<!-- vf:auto:<name> -->
...rewritten by the tool every time...
<!-- /vf:auto:<name> -->
```

**Rule: edit PROJECT.md only outside `<!-- vf:auto:... -->` blocks.** Good uses: story rules, running gags, things never to repeat, continuity notes. Text inside a block is overwritten. Never delete or edit the markers.

## json files

- `project.json`: `slug`, `lang`, `aspect`, `title`, `logline`, `premise`, `world`, `style_prompt` (appended verbatim to every image prompt), `palette`, `visual_rules`, `narrator` (bool), `narrator_voice` (a Gemini TTS voice such as `Leda`, `Puck`, `Kore`), `tone`, `music_style`, `story_rules`, optional `keyframe_quality` (`"high"` = klein-9b keyframes/stills; default is the cheaper klein-4b), `characters`, `places`, `created_at`, `version`.
- `characters/<id>/character.json`: `id`, `name`, `role`, `look` (appearance, used verbatim in prompts), `personality`, `voice` (`{tts_voice, description}`), `ref` (main image path `ref/main.png`), `extra_refs` (`ref/extra-<n>.png` if any).
- `places/<id>/place.json`: `id`, `name`, `desc` (scene description), `plate` (image path such as `plates/main.jpg`).

Character and place ids are ASCII (`^[a-z][a-z0-9-]{1,30}$`) and unique across both kinds. Do not hand-edit json when a command can do it (`vf character add --replace --id <id>`).

## Costs

`.vf/costs.jsonl` holds one JSON row per paid call: `project`, `step`, `item`, `run`, `model`, `outcome` (`ok`, `invalid` = LLM answer failed validation, `qa_reject` = image rejected by QA, `blocked`, `error`), `units`, `usd` (an estimate, `null` when unknown), `at`, `estimated`. The cost table in PROJECT.md is rebuilt from it.
