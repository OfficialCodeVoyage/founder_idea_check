---
paths:
  - "apps/chat/lib/env-schema.ts"
  - "apps/chat/lib/env.ts"
  - "apps/chat/scripts/check-env.ts"
  - "apps/chat/lib/config-requirements.ts"
  - "apps/chat/chat.config.ts"
  - "apps/chat/lib/ai/core-chat-agent.ts"
  - "apps/chat/lib/ai/model-capabilities.ts"
  - "turbo.json"
  - ".env.example"
---
# Env and config — landmines

- **`apps/chat/lib/env-schema.ts` is the one list of server env vars.** A new var goes there, in the root
  `.env.example` (name, purpose, no secret), in `turbo.json` `globalEnv` (turbo runs in strict mode and silently drops
  anything unlisted; Incident 10) and, when a feature needs it, as a check in `scripts/check-env.ts`. Guard for the
  turbo half: `lib/env-schema.test.ts`, a census of the schema against `globalEnv`. Variables only the sidecar reads
  (`apps/research/app/config.py`) go in the root `.env.example` too, but not in the schema or in `globalEnv`.
- **The repo-root `.env.local` is the only env file the app, drizzle and evals load.** There is no
  `apps/chat/.env.local` and no `apps/chat/.env.example`. `.env.local` is gitignored; never open it.
- **Model ids live in `chat.config.ts`** (typed per gateway). The gate judge uses the chat workflow model; a change
  there changes every verdict. Guard: `lib/config-schema.test.ts`.
- **`maxOutputTokens` has one reader**, `lib/ai/core-chat-agent.ts` (Incident 6). Guard: `chat.config.test.ts`.
- **A model with no stated window, output ceiling or price is unknown, never zero** (Incident 1). The gateways write
  `0` and `{}` for a model the capability table does not cover; read them through `lib/ai/model-capabilities.ts`, and
  treat a non-positive `max_tokens` as "use the configured cap". Guards: `lib/ai/model-capabilities.test.ts`,
  `lib/ai/token-utils.test.ts`; no automatic guard for the `max_tokens` fallback itself.
- **`chat.config.ts` sets research `hosted: false` for local use only.** A deployment must not copy it.
- Env var change → update the root `.env.example` and `README-DEV.md` in the same commit.
