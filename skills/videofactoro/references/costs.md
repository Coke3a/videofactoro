# Costs

All calls go through Cloudflare Workers AI / AI Gateway and are billed to the user's Cloudflare account (Unified Billing credits). `vf` logs an **estimate** for each call in `projects/<slug>/.vf/costs.jsonl`. The source of truth is the Cloudflare dashboard.

## Price table (`tools/pricing.mjs`, as of 2026-10-27)

| Model | Use | Price | Verified |
|---|---|---|---|
| `@cf/black-forest-labs/flux-2-klein-9b` | character refs, place plates (and keyframes when `keyframe_quality` is `high`) | $0.015 first MP + $0.002 per extra MP + $0.002 per ref MP | yes |
| `@cf/black-forest-labs/flux-2-klein-4b` | keyframes and motion stills (default) | $0.000287 per output 512x512 tile + $0.000059 per input tile (≈ $0.0025 per 9:16 keyframe with 3 refs) | yes |
| `black-forest-labs/flux-3-video` | video | $0.06 draft / $0.17 hd / $0.29 fhd per clip | **no** |
| `@cf/cloudflare/clef-omni` | QA | $0.15 per M input tokens | yes |
| `google/gemini-3.8-flash` | LLM | $0.75 / $3.75 per M in/out | yes |
| `anthropic/claude-haiku-5.5` | LLM fallback | $0.10 / $0.50 per M in/out | **no** |
| `google/gemini-3.8-flash-tts` | narration | $0.014 per minute | **no** |
| `elevenlabs/music-v2` | music | $0.0025 per second (min 10 s) | yes |

## Measured live runs

| Run | Result | USD |
|---|---|---|
| `project create` (2 characters, 3 places) | ~3 min | $0.161 |
| `character add` (1 character) | | $0.063 |
| `clip` 6 s draft, no audio | | $0.088 |
| `clip` 6 s draft + narration (music gated off), 1 keyframe reroll | | $0.112 |
| music alone, 10 s | | ~$0.025 |

Rules of thumb: a new project with one draft clip is about $0.25–0.30. Each extra draft clip is about $0.09–0.14. HD adds about $0.11 per clip.

## Budgeting

- Run `--dry-run` first on any paid command; it prints each step's estimated USD.
- Rerolls cost money: `--max-rerolls 0` for cheap exploration, the default 2 for real work.
- Failed paid calls are logged too (`outcome: error|blocked|qa_reject`), so the totals include waste.
- Report the sum of `cost.usd` to the user and say that the agent's own LLM usage is not included.

## Live test 2026-10-27 (Hermes, 6 clips, before the cost changes)

| Clip | Cost |
|---|---|
| film 20 s draft | $0.31–0.33 |
| film 90 s draft (13 shots) | $1.38–1.41 |
| motion 90 s (18 scenes) | $0.68–0.72 |

Split: video 39 %, images 37 %, music 18 %, LLM + TTS + QA 6 %. 32 video attempts were blocked by moderation (logged with `usd: null`; whether they are billed is unknown).

## Cost levers (since 2026-10-27)

- Keyframes/stills on klein-4b: about $0.0025 instead of $0.023 each. `"keyframe_quality": "high"` in `project.json` switches back to 9b.
- Film shots aim for ~18 s (90 s ≈ 5 shots instead of 13): flux-3-video is priced per clip for 5–20 s.
- Music comes from the shared library `_music/` when clef-omni finds a fitting track ($0, plus ~$0.0003 per track it listens to). Otherwise one new 90 s track ($0.225) is generated once and reused by later clips.
- Measured live on Hermes after these changes (2026-10-27): motion 60 s = $0.151 (12 scenes, 22 klein-4b images ≈ $0.002 each incl. 5 QA rerolls, music loop $0.075); film 30 s = $0.284 (3 shots of 10 s, video $0.18). So film 90 s ≈ $0.7–0.8, motion 90 s ≈ $0.2.
- Seen with klein-4b: characters are smaller in frame and an accessory can jump between characters (the cat wearing the dog's bandana). Use `keyframe_quality: "high"` for hero shots or when this shows up often.
- Blocked or crashed jobs: `resume` (editing `plan.json` if needed) instead of a new `--id`, which pays for the plan and every finished shot again.

## Motion v2 (HyperFrames + GSAP pose sprites)

- `vf character poses`: about $0.04 per character, once (6 poses and their talk twins, with QA).
- `vf prop add`: about $0.001 per prop. Stage spots: one cheap clef call per place, cached.
- `vf motion`: about $0.02–0.03 per clip (story and scene LLM, TTS, staging checks) + music: $0 from the shared library, $0.2275 for a new 90 s track. `--dry-run` prices the worst case (new track).
- Render time is CPU, not money: about 3.5× the clip length on 2 vCPU; one render at a time.
- The older motion figures above (stills per scene, 18 scenes ≈ $0.7) describe the removed ffmpeg engine.
