# videofactoro docs

The overview and quick start are in the [main README](../README.md).

## Setup

1. Run `bash tools/set-env.sh` in your own Terminal. Key input is hidden, and it writes `.env` with chmod 600.
2. Run `node bin/vf.mjs setup` to check the token and credits.
3. Re-check any time with `node bin/vf.mjs doctor` (read-only).

You never copy `.env.example` or type keys by hand; it only lists the variable names. `.env` must never be committed (the pre-commit hook from `node tools/install-hooks.mjs` blocks it). Only the `.env` at the repo root is read, and process env always wins.

## Code map

| Path | Role |
|---|---|
| `bin/vf.mjs` | Entry point and command router |
| `tools/cf.mjs` | Workers AI / AI Gateway client: run, retry, async polling, media download, redaction |
| `tools/llm.mjs` | Structured JSON from Gemini/Haiku with schema validation and repair rounds |
| `tools/images.mjs` | FLUX.2 klein 9B (refs, plates) and 4B (keyframes, stills) with inline reference images; sizes per aspect |
| `tools/qa.mjs`, `tools/qa-rules.mjs` | clef-omni vision QA and the pass/fail rules per asset type |
| `tools/bible.mjs` | Project bible schema, PROJECT.md/EPISODES.md rendering, cost table |
| `tools/project-create.mjs`, `character-add.mjs`, `place-add.mjs` | Project building commands |
| `tools/clip.mjs` | Single-shot clip pipeline |
| `tools/audio.mjs` | TTS, music and the ffmpeg mix |
| `tools/shots.mjs` | Shared keyframe/video steps and a small concurrency pool |
| `tools/film.mjs`, `motion.mjs`, `longform.mjs` | Long videos: multi-shot AI film, motion (HyperFrames + GSAP cut-out pose sprites cartoon), shared validation and audio finish |
| `tools/assemble.mjs` | ffmpeg helpers: normalize, concat, narration track |
| `tools/jobs.mjs`, `wait.mjs`, `status.mjs` | Background jobs, heartbeat, resume |
| `tools/state.mjs` | Per-command checkpoints (pay-once resume) |
| `tools/cache.mjs`, `asset-find.mjs` | Project asset library (cache keys, Thai search words) and search |
| `tools/entities.mjs`, `md.mjs` | Character/place helpers; `vf:auto` block rewriting |
| `tools/risk.mjs` | Prompt risk check (protected names) before paid calls |
| `tools/pricing.mjs`, `cost.mjs` | Price table and cost log |
| `skills/videofactoro/` | Agent skill (SKILL.md + references) |

## Conventions

- One JSON object on stdout, logs on stderr, no prompts.
- Every paid call goes through `withRetry`, writes a cost row, and is checkpointed before the next step.
- Secrets never reach stdout, stderr, logs, project files or error messages; `redact()` scrubs known values and signed URLs are stripped.
- Tool messages are in Thai; the agent skill is in English.
