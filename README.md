# videofactoro

`vf` is a command-line video factory for AI agents. Give it a one-line idea and it builds a story project (world, visual style, characters, places), then renders short clips with narration and music. Every step runs on **Cloudflare Workers AI / AI Gateway**: one account and one bill, with no other providers.

It is designed for automation:

- **Agent-first CLI.** Each command prints exactly one JSON object on stdout, logs to stderr, uses fixed exit codes, and never prompts.
- **Background jobs.** Long commands return a job id at once; `vf wait` blocks up to 9 minutes per call.
- **Resumable and pay-once.** Every paid step is checkpointed. A crashed or killed run continues where it stopped and never pays twice for finished work (including in-flight video requests).
- **Consistent characters.** Each character has a locked reference image and look; every frame is generated from those refs and QA-checked by a vision model.
- **Cost-aware.** `--dry-run` prices any command before it runs; every call is logged to `.vf/costs.jsonl`.
- **No dependencies.** Node.js 22 and ffmpeg. Nothing to `npm install`.

## Quick start

Requirements: Node.js 22+, `ffmpeg`/`ffprobe` on PATH, and a Cloudflare account with Workers AI, an API token (Workers AI Read + Edit), and AI Gateway Unified Billing credits.

Run these in your own Terminal (you never type keys into files or a chat):

```sh
bash tools/set-env.sh         # asks for CLOUDFLARE_AI_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN with hidden input, writes .env (chmod 600, git-ignored)
node bin/vf.mjs setup         # checks the token and the credits
node tools/install-hooks.mjs  # pre-commit hook that blocks committed secrets
node bin/vf.mjs doctor        # read-only re-check, any time
```

`.env.example` only lists the variable names; `set-env.sh` writes `.env` for you.

Then:

```sh
node bin/vf.mjs project create --prompt "A grumpy cat and a cheerful dog share a tiny apartment" --name catdog --dry-run
node bin/vf.mjs project create --prompt "A grumpy cat and a cheerful dog share a tiny apartment" --name catdog
node bin/vf.mjs wait catdog
node bin/vf.mjs clip catdog --prompt "The dog tries to wake the sleeping cat with a squeaky toy"
node bin/vf.mjs wait catdog
open projects/catdog/renders/*.mp4
```

## Commands

| Command | What it does |
|---|---|
| `vf doctor` / `vf setup` | Check the environment / verify token and credits (setup is run by the user) |
| `vf project create --prompt "..." --name <slug>` | Bible + characters + places from one prompt |
| `vf project show <slug>` | Project summary as JSON |
| `vf character add <slug> --prompt "..."` | Add a character (`--image` to use your own art, `--replace --id` to redo one) |
| `vf place add <slug> --prompt "..."` | Add a place (background plate) |
| `vf asset find <slug> <terms...>` | Search the project library |
| `vf clip <slug> --prompt "..."` | One 5–20 s shot with narration and music (draft by default, `--hd` for final) |
| `vf wait <slug> [job-id]` | Wait for a background job |
| `vf status <slug>` | Recent jobs |

All paid commands accept `--dry-run` and `--foreground`. The full flag reference is in [skills/videofactoro/references/commands.md](skills/videofactoro/references/commands.md).

Exit codes: `0` ok · `1` INTERNAL · `2` USAGE · `3` CONFIG · `4` BLOCKED (content filter) · `5` PROVIDER.

## How a clip is made

1. **Plan:** an LLM (Gemini 3.8 Flash, falling back to Claude Haiku 5.5) picks characters and a place and writes the first-frame prompt, a timed video prompt with diegetic sound, narration and a music brief.
2. **Keyframe:** FLUX.2 klein 9B renders the first frame from the character reference images and the place plate. A vision model (clef-omni) checks it and it is rerolled if needed.
3. **Video:** FLUX.3 Video animates the keyframe (image-to-video, with scene audio).
4. **Narration:** Gemini TTS reads the line in the project narrator's voice.
5. **Music:** ElevenLabs Music v2 writes an instrumental bed when the shot needs one.
6. **Mix:** ffmpeg combines scene audio, narration and music, with the music ducked under the voice.

Typical costs: a new project with two characters and three places is about $0.16; a 6 s draft clip with narration is about $0.11. See [costs](skills/videofactoro/references/costs.md).

## Project files

Projects live in `$VF_PROJECTS` (default `./projects/`, git-ignored). Start reading at `projects/<slug>/PROJECT.md`. Final clips are in `projects/<slug>/renders/`. The layout is described in [project.md](skills/videofactoro/references/project.md).

## Using it from an agent

- **Claude Code:** open the repo. The `videofactoro` skill (`.claude/skills/videofactoro` → `skills/videofactoro`) loads automatically. Then ask, for example, "make a project about a penguin who runs a coffee shop and a first clip".
- **Other agents** (Codex, Cursor, Gemini CLI, Hermes, custom): point them at [AGENTS.md](AGENTS.md), which links the skill. The skill's [SKILL.md](skills/videofactoro/SKILL.md) is plain Markdown with the rules, the flow, the error table and the report format.

## Status

| Feature | State |
|---|---|
| Project, characters, places, library, jobs, costs | done |
| `vf clip` single shot + narration + music | done |
| `vf film` multi-shot episodes | planned |
| `vf motion` motion graphics | planned |

## Development

```sh
npm test    # node --test, no network
```

The design spec is [docs/superpowers/specs/2026-10-26-videofactoro-design.md](docs/superpowers/specs/2026-10-26-videofactoro-design.md). Live probe results are in [spikes/RESULTS.md](spikes/RESULTS.md).
