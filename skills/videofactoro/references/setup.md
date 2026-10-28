# Setup and security

## Requirements

- Node.js 22+. `vf setup` installs the pinned `hyperframes` and `gsap` packages (`npm ci`) and Chrome (`hyperframes browser ensure`) for `vf motion`; `vf doctor` checks them. GSAP has its own Standard License (see `NOTICE`), not MIT.
- `ffmpeg` and `ffprobe` on PATH (clip mixing and media checks)
- A Cloudflare account with Workers AI, an API token with Workers AI Read + Edit, and AI Gateway Unified Billing credits loaded

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `CLOUDFLARE_AI_ACCOUNT_ID` | yes | Cloudflare account id |
| `CLOUDFLARE_AI_API_TOKEN` | yes | Token with Workers AI Read + Edit |
| `VF_AIG_GATEWAY_ID` | no | Route calls through a named AI Gateway (logs, caching) |
| `VF_PROJECTS` | no | Where projects live (default `./projects`) |
| `VF_USD_THB` | no | Exchange rate for the THB column in PROJECT.md (default 33.5) |

Values come from the process environment first, then from `.env` at the repo root.

## First-time setup (the user does this)

In their own Terminal, from the repo root:

```sh
bash tools/set-env.sh          # asks for the two values with hidden input, writes .env (chmod 600, git-ignored)
node bin/vf.mjs setup          # checks the token and the credits
node tools/install-hooks.mjs   # optional: pre-commit hook that blocks committed secrets
node bin/vf.mjs doctor         # read-only re-check, any time
```

`.env.example` only lists the variable names. Nobody copies it or types keys into files by hand.

## Rules for agents

- Never open, print, grep or ask for `.env`, `.dev.vars`, `cloudflare.json` or any key. Report presence and status only.
- Never run `set-env.sh` or `setup` on the user's behalf when keys are missing. On exit 3 (CONFIG), stop and give the user the commands above.
- Never put tokens, signed URLs or gateway output URLs in logs, files or chat. `vf` redacts known secrets from its own output.
- Never resubmit a paid call whose outcome is unknown. Use `resume`; it follows up on the saved request.

## Other agents (Codex, Cursor, Gemini CLI, Hermes…)

Claude Code loads this skill automatically from `.claude/skills/videofactoro` (a symlink to `skills/videofactoro`). Other agents should read `AGENTS.md` at the repo root, which points here. The CLI itself works the same for any agent that can run a shell command and read JSON.
