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

Requirements: Node.js 22+, `ffmpeg`/`ffprobe` on PATH, and a Cloudflare account with Workers AI, an API token (Workers AI Read + Edit), and AI Gateway Unified Billing credits. `vf setup` also installs HyperFrames and GSAP (`npm ci`) and Chrome for `vf motion`; `vf doctor` checks them.

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
| `vf character poses <slug> <id>` | Make cut-out pose sprites + talk twins for motion (`--poses idle,happy`, `--replace`; `--replace --poses happy` redoes only those) |
| `vf place add <slug> --prompt "..."` | Add a place (background plate) |
| `vf prop add <slug> --prompt "..."` | Make a cut-out prop sprite for motion (`--id`; ~$0.001) |
| `vf asset find <slug> <terms...>` | Search the project library |
| `vf music list <slug>` / `vf music add <slug> <file.mp3> --prompt "..."` | Show or extend the shared music library (`_music/`, reused across projects; clef-omni picks a fitting track, new 90 s tracks are generated only when none fits) |
| `vf clip <slug> --prompt "..."` | One 5–20 s shot with narration and music (draft by default, `--hd` for final) |
| `vf film <slug> --prompt "..." --duration 90` | Multi-shot generative AI video, 20–180 s |
| `vf motion <slug> --prompt "..." --duration 60` | Cartoon from pose sprites (HyperFrames + GSAP), 20–180 s, 9:16, no video model; needs `vf character poses` first |
| `vf wait <slug> [job-id]` | Wait for a background job |
| `vf status <slug>` | Recent jobs |

All paid commands accept `--dry-run` and `--foreground`. The full flag reference is in [skills/videofactoro/references/commands.md](skills/videofactoro/references/commands.md).

Exit codes: `0` ok · `1` INTERNAL · `2` USAGE · `3` CONFIG · `4` BLOCKED (content filter) · `5` PROVIDER.

## How a clip is made

1. **Plan:** an LLM (Gemini 3.8 Flash, falling back to Claude Haiku 5.5) picks characters and a place and writes the first-frame prompt, a timed video prompt with diegetic sound, narration and a music brief.
2. **Keyframe:** FLUX.2 klein 4B (9B for character references, or with `keyframe_quality: "high"`) renders the first frame from the character reference images and the place plate. A vision model (clef-omni) checks it and it is rerolled if needed.
3. **Video:** FLUX.3 Video animates the keyframe (image-to-video, with scene audio).
4. **Narration:** Gemini TTS reads the line in the project narrator's voice.
5. **Music:** ElevenLabs Music v2 writes an instrumental bed when the shot needs one.
6. **Mix:** ffmpeg combines scene audio, narration and music, with the music ducked under the voice.

Typical costs: a new project with two characters and three places is about $0.16; a 6 s draft clip with narration is about $0.11; a 90 s film draft is about $1.5–2; a motion cartoon is about $0.02–0.03 per clip plus music (poses about $0.04 per character, once). See [costs](skills/videofactoro/references/costs.md).

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
| `vf film` multi-shot AI video (20–180 s) | done |
| `vf motion` pose-sprite cartoon (20–180 s) | done |

## Development

```sh
npm test    # node --test, no network
```

Logs, error messages and the internal LLM prompts are in Thai; the JSON output, the docs and the agent skill are in English.

## Self-hosting

videofactoro is a tool you run yourself. There is no hosted service and no shared account:

- You bring your own Cloudflare account, API token and AI Gateway credits. Every paid call is billed to your account. Prices in `skills/videofactoro/references/costs.md` are estimates; some are unverified, so check your Cloudflare bill.
- You are responsible for what you generate and how you use it, including the terms of the models it calls (Black Forest Labs FLUX, ElevenLabs Music, Google Gemini and others on Cloudflare), especially for commercial use.
- Keep your token to yourself. Nothing in this repo needs anyone else's keys.

## License

[MIT](LICENSE). Provided as is, without warranty. The author does not run, support or pay for any deployment.

The motion renderer installs `gsap` from npm at setup time. GSAP is licensed under the [GSAP Standard License](https://gsap.com/standard-license), not MIT, and is not part of this repository (see `NOTICE`).
