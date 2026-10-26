# Agent instructions

This repo is `videofactoro`, a CLI (`node bin/vf.mjs`) that agents use to make AI videos on Cloudflare Workers AI.

**Before running any `vf` command, read [skills/videofactoro/SKILL.md](skills/videofactoro/SKILL.md)** and follow it. It holds the rules, the standard flow, the job/wait loop, the exit-code table and the report format. Details are in `skills/videofactoro/references/`.

Non-negotiable:

- Never open, print or ask for `.env`, `.dev.vars`, `cloudflare.json` or any API key. On exit code 3 (CONFIG), stop and tell the user to run `bash tools/set-env.sh` and then `node bin/vf.mjs setup` in their own Terminal.
- Never ask the user questions mid-run. Decide, then report what you decided.
- Draft clips first; `--hd` only after the user approves.
- Report the summed `cost.usd` at the end.

Development: `npm test` (offline). Code map: [docs/README.md](docs/README.md).
