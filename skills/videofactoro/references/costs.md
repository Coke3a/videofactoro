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
- Film shots aim for ~9 s (90 s ≈ 10 shots instead of 13): the video price is per clip.
- Videos over 30 s pay for one 30 s music loop ($0.075) instead of the full length ($0.23 for 90 s).
- Expected after these: film 90 s ≈ $0.7–0.9, motion 90 s ≈ $0.2–0.3 (estimate, not yet measured live).
- Blocked or crashed jobs: `resume` (editing `plan.json` if needed) instead of a new `--id`, which pays for the plan and every finished shot again.
