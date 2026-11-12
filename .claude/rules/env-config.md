---
paths:
  - "apps/chat/lib/env-schema.ts"
  - "apps/chat/lib/env.ts"
  - "apps/chat/scripts/check-env.ts"
  - "apps/chat/lib/config-requirements.ts"
  - "apps/chat/chat.config.ts"
  - "turbo.json"
  - "apps/chat/.env.example"
---
# Env and config — landmines

- **`apps/chat/lib/env-schema.ts` is the one list of server env vars.** A new var goes there, in
  `apps/chat/.env.example` (name only), in `turbo.json` `globalEnv` (turbo runs in strict mode and silently drops anything unlisted), and,
  when a feature needs it, as a check in `scripts/check-env.ts`.
- **The repo-root `.env.local` is the only env file the app, drizzle and evals load.** There is no
  `apps/chat/.env.local`. It is gitignored; never open it.
- **Model ids live in `chat.config.ts`** (typed per gateway). The gate judge uses the chat workflow model; a change
  there changes every verdict. Guard: `lib/config-schema.test.ts`.
- **`maxOutputTokens` has one reader**, `lib/ai/core-chat-agent.ts`. Guard: `chat.config.test.ts`.
- **`chat.config.ts` sets research `hosted: false` for local use only.** A deployment must not copy it.
- Env var change → update `apps/chat/.env.example` and `README-DEV.md` in the same commit.
