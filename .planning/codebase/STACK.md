<!-- refreshed: 2026-11-12 -->
last_mapped_commit: c9be663d
# Technology Stack

**Analysis Date:** 2026-11-12

Versions below are the ones resolved in `bun.lock` for the TypeScript side, and the declared ranges in
`apps/research/pyproject.toml` for the Python side (it has no lockfile). A bare number with a caret in
`package.json` resolves to the lockfile version shown here.

## Languages

**Primary:**
- TypeScript 6.0.2 (exact pin, `apps/chat/package.json`) - the Next.js app `apps/chat` and `packages/thread`.
  Compiler settings in `apps/chat/tsconfig.json`: `strict`, `module: Preserve`, `noEmit`, path alias `@/*` to the app root.
- Python 3.11 only (`requires-python = ">=3.11,<3.12"` in `apps/research/pyproject.toml`) - the research sidecar
  `apps/research`. The upper bound is kept as tested (OASIS 0.2.6 itself allows `<3.15`); see Pins below.

**Secondary:**
- SQL - hand-reviewed Drizzle migrations in `apps/chat/lib/db/migrations/` (files `0000` to `0053`, ordered by
  `apps/chat/lib/db/migrations/meta/_journal.json`, not by file number: there is no `0035` and two files are numbered `0036`).
- Bash - `scripts/verify.sh`, `scripts/test-integrity.sh`, `apps/chat/scripts/dev-local.sh`, `apps/chat/scripts/with-db.sh`.
- CSS (Tailwind 4) - `apps/chat/app/globals.css`.

## Runtime

**Environment:**
- Bun 1.3.14 (`packageManager` in `package.json`; `engines.bun >= 1.3.14`, `engines.node >= 20.9.0`). Bun runs scripts and
  installs; the Next.js server itself runs under Node (`next start`, `apps/chat/package.json`).
- Python 3.11 in a venv at `apps/research/.venv` (the README suggests `uv venv --python 3.11`; CI uses `python -m venv`,
  `.github/workflows/ci.yml`). Container base image `python:3.11-slim` (`apps/research/Dockerfile`).
- Postgres 17 with pgvector (`pgvector/pgvector:pg17`, `docker-compose.yml`) and Valkey 9.1.3 (`valkey/valkey:9.1.3-alpine3.24`,
  `docker-compose.yml`) as local services.

**Package Manager:**
- Bun workspaces (`workspaces: ["apps/*", "packages/*"]` in `package.json`). Lockfile: `bun.lock` present (`lockfileVersion` 1).
- Python: pip with `hatchling >= 1.27` as build backend (`apps/research/pyproject.toml`). Lockfile: missing, ranges only.

**Monorepo layout:** turbo 2.9.5 (`turbo.json`) over `apps/chat` (`@chatjs/chat` 0.2.0), `packages/thread` (`@chatjs/thread` 0.0.0),
`packages/cli` (`@chat-js/cli` 0.7.0), `packages/registry` (`@chat-js/registry` 0.1.2). `apps/research` is not a Bun workspace
member: it has no `package.json`, and Python is driven by its own `pyproject.toml`.

## Frameworks

**Core (`apps/chat/package.json`):**
- Next.js 16.3.0 - App Router, with `typedRoutes`, `cacheComponents` and `partialPrefetching` on (`apps/chat/next.config.ts`).
  `pino` and `pino-pretty` are `serverExternalPackages`; `prompts/**/*` is force-traced (`outputFileTracingIncludes`) because
  `lib/phases/runtime.ts` reads prompt files from disk at request time.
- React 19.2.3 / react-dom 19.2.3.
- AI SDK 6: `ai` 6.0.323, `@ai-sdk/react` 3.0.326, `@ai-sdk/openai` 3.0.137, plus `@ai-sdk/anthropic` 3.0.138, `@ai-sdk/gateway` 3.0.229,
  `@ai-sdk/google` 3.0.141, `@ai-sdk/openai-compatible` 2.0.90, `@ai-sdk/mcp` 1.0.101, `@openrouter/ai-sdk-provider` 2.10.0,
  `@ai-sdk/devtools` 0.0.29. All are exact-pinned (no range) in `apps/chat/package.json`.
- Drizzle ORM 0.45.2 over the `postgres` (postgres.js) driver 3.4.9 (`apps/chat/lib/db/client.ts`); drizzle-kit 0.31.10
  (`apps/chat/drizzle.config.ts`).
- better-auth 1.6.34 with the Drizzle adapter (`apps/chat/lib/auth.ts`); it, `@better-auth/core` and `@better-auth/electron`
  are exact pins in `apps/chat/package.json`.
- tRPC 11.16.0 (`@trpc/server`, `@trpc/client`, `@trpc/tanstack-react-query`) with TanStack Query 5.97.0 and superjson 2.2.6
  (`apps/chat/trpc/`).
- Tailwind CSS 4.3.2 through `@tailwindcss/postcss` (`apps/chat/postcss.config.mjs`), `tw-animate-css`, `@tailwindcss/typography`.
  UI is shadcn/ui on Radix (`apps/chat/components.json`: style `default`, base colour `zinc`, `lucide-react` 0.553.0 icons).
- State and forms: zustand 5.0.12, react-hook-form, nuqs 2.8.9 (URL state), zod 4.3.6, `@t3-oss/env-nextjs` 0.13.11 for env validation.
- Rich content: streamdown 2.5.0 (`@streamdown/code|math|mermaid`), lexical 0.32.1, CodeMirror 6, `@xyflow/react` 12.11.3 (the canvas),
  echarts-for-react, react-data-grid, papaparse.
- Streams: `resumable-stream` 2.2.10 on the `redis` client 5.11.0.
- Logging: pino 9.14.0 (`apps/chat/lib/logger*`), pino-pretty 13 for dev.

**Core (`apps/research/pyproject.toml`):**
- FastAPI `>=0.115,<1.0`, uvicorn[standard] `>=0.32,<1.0`, pydantic `>=2.9,<3.0`. These are the only runtime dependencies of the
  signal half; every source adapter uses stdlib `urllib` (`apps/research/app/http.py`).
- Optional extra `simulation`: `camel-oasis==0.2.6` and `mcp<2` (pulls camel-ai 0.2.90, torch, sentence-transformers, igraph).

**Testing:**
- vitest 4.1.4 for `apps/chat` (`apps/chat/vitest.config.ts`, `bun run test:unit` runs `vitest run`); `bun test` for `packages/thread` and `packages/cli`.
- Playwright 1.59.1 e2e (`apps/chat/playwright.config.ts`), local only; its `webServer` runs `bun run dev:local`.
- evalite 1.0.0-beta.8 for the gate calibration eval (`apps/chat/evalite.config.ts`, `bun run eval:gate`), stored in SQLite
  through `better-sqlite3` 12.
- pytest `>=8.3,<10.0` with httpx `>=0.27,<1.0` (`apps/research/pyproject.toml`; `testpaths = ["tests"]`, no network, no key).

**Build/Dev:**
- turbo 2.9.5 (exact pin, root `package.json`); dotenv-cli `^11.1.0` loads the repo-root env file for scripts.
- Biome 2.4.16 through ultracite 7.4.3 (`apps/chat/biome.jsonc` extends `ultracite/core`, `ultracite/react`, `ultracite/next`;
  `packages/thread` has Biome 2.4.16 as its own devDependency and calls `biome`). `lint` is `ultracite check`, `format` is `ultracite fix`.
- ruff `>=0.7,<1.0` for Python: line length 100, target `py311`, rules `E,F,I,UP,B,SIM,RUF`, `E501` ignored
  (`apps/research/pyproject.toml`). `ruff format` is not enforced.
- tsx 4.21.0 runs `lib/db/migrate.ts` before `next build`.
- `bun run verify` (`scripts/verify.sh`) = ultracite check + `next typegen` + `tsc --noEmit` for `apps/chat`, biome + `tsc` for
  `packages/thread`, and `ruff check app tests` when `apps/research/.venv` exists.
- Agent skills live in `.agents/skills/` (symlinked from `.claude/skills/`) and are hash-locked by `skills-lock.json`.
- Dev ports: `.worktree-env.json` with `.agents/skills/worktree-ports/scripts/worktree-env.ts` (base 3000, stride 10, slot from
  `CHATJS_DEV_SLOT`) serves `bun run dev`; `bun run dev:local` (`apps/chat/scripts/dev-local.sh`) defaults `PORT` to 3100.

## Key Dependencies

**Critical:**
- `ai` 6.0.323 - the agent loop, `streamText`, tool calling. `ToolLoopAgent`'s default `stopWhen` of 20 steps is why
  `maxResearcherSteps` is set explicitly in `apps/chat/chat.config.ts`.
- `drizzle-orm` 0.45.2 + `pgvector` column type - facts, embeddings and the gate ledger (`apps/chat/lib/db/schema.ts`).
- `better-auth` 1.6.34 - sessions and OAuth (`apps/chat/lib/auth.ts`).
- `fastapi` + `camel-oasis` 0.2.6 - the sidecar surface and persona simulation (`apps/research/app/main.py`,
  `apps/research/app/simulation/oasis_runner.py`).

**Infrastructure:**
- `files-sdk` 2.1.0 with `@vercel/blob` 2.4.0 - file storage adapter (`apps/chat/lib/storage-provider.ts`).
- `@vercel/sandbox` 1.9.3 - code execution tool, disabled in config (`apps/chat/tools/platform/code-execution.ts`).
- `@modelcontextprotocol/sdk` 1.29.0 + `@ai-sdk/mcp` - MCP connectors, disabled in config (`apps/chat/lib/ai/mcp/`).
- `@tavily/core` 0.3.7, `@mendable/firecrawl-js` 1.29.1 - optional web-search backends (`apps/chat/tools/platform/steps/web-search.ts`).
- `@better-auth/electron` 1.6.34 - imported unconditionally by `apps/chat/lib/auth.ts`, registered only when `desktopApp.enabled`
  (false in `apps/chat/chat.config.ts`).
- `@ai-sdk/devtools` 0.0.29 - dev middleware wired in `apps/chat/lib/ai/providers.ts`.

**Vendored Python (do not modernise):** `apps/research/app/text/cjk.py`, `apps/research/app/text/relevance.py`,
`apps/research/app/pipeline/dedupe.py`, `apps/research/app/pipeline/entity_extract.py` come from `mvanhorn/last30days-skill` (MIT);
ruff per-file ignores in `apps/research/pyproject.toml` keep them diffable. Ledger: `THIRD_PARTY-research.md`, licence texts in `LICENSES/`.

## Pins and why

- **Python `>=3.11,<3.12`** (`apps/research/pyproject.toml`, `apps/research/Dockerfile`, CI `python-version`): `camel-ai/oasis` 0.2.5 declared
  `python = ">=3.10.0,<3.12"`; camel-oasis 0.2.6 and camel-ai 0.2.90 declare `>=3.10,<3.15`, so OASIS no longer forces the bound.
  It stays at 3.11 as the tested version (loosening is a separate change; the exact-pinned dependency tree would need re-resolving). Dependabot ignores
  Python minor/major bumps for the Docker image (`.github/dependabot.yml`).
- **`mcp<2`** in the `simulation` extra: camel-ai imports `from mcp.server import FastMCP`, a name mcp 2 removed, so with camel-oasis
  0.2.5 an unpinned install succeeded and then failed at `import oasis`. camel-oasis 0.2.6 itself requires `mcp==1.29.0`, so the pin is
  now a guard against a later OASIS release. Dependabot ignores `mcp >= 2` (`.github/dependabot.yml`).
- **`ultracite 7.4.3` and `@biomejs/biome 2.4.16`** are exact pins (Biome in `apps/chat` and in `packages/thread`; Dependabot holds its minors); an unpinned `bunx ultracite` pulls a newer major (`CLAUDE.md`).
- **`better-auth`, `@better-auth/core` and `@better-auth/electron` 1.6.34** are exact pins in `apps/chat/package.json` and
  must stay equal (`better-auth` requires its own core exactly, so a caret there could let a lockfile refresh nest a second
  core, and the electron plugin peers on core `^1.6.34`). A root `overrides` entry that once forced 1.5.6
  is gone: on 1.6.34 it made `import "better-auth"` fail. Do not add an override back; treat any change here as a dependency task.
- **`apps/chat` overrides** (`apps/chat/package.json`): `commander ^14.0.0`, and `evalite` is pointed at the app's own `ai` and
  `better-sqlite3` so the eval harness runs the same AI SDK.
- **`igraph` is GPL-2.0-or-later** and enters only through the `simulation` extra (`apps/research/pyproject.toml`); the default image
  does not install it and no simulation image is published (`THIRD_PARTY-research.md`).
- **Exact pins without a recorded reason:** `next` 16.3.0, `react` and `react-dom` 19.2.3, `typescript` 6.0.2, the `@ai-sdk/*` family,
  `lucide-react`, `@xyflow/react`, `resumable-stream`, `files-sdk` (`apps/chat/package.json`). Do not loosen them without a dependency task.
- **Valkey tag is exact** (`valkey/valkey:9.1.3-alpine3.24`): it replaced `redis:7-alpine`, whose moving tag resolved to a
  source-available Redis (`docker-compose.yml`). `searxng/searxng:latest` in `docker-compose.searxng.yml` is the one moving tag, opt-in.

## Configuration

**Environment:**
- Server env is validated at import by `createEnv` in `apps/chat/lib/env.ts` from `apps/chat/lib/env-schema.ts` (the one list of
  server variables). `DATABASE_URL` and `AUTH_SECRET` are the only required ones; Playwright runs get test defaults.
- The repo-root `.env.local` (gitignored, never opened) is the only env file the app, drizzle, evals and Playwright load
  (`apps/chat/drizzle.config.ts`, `apps/chat/playwright.config.ts`, `apps/chat/scripts/dev-local.sh`). The tracked template is the
  repo-root `.env.example`.
- `bun run dev` goes through turbo, whose strict env mode forwards only the names in `globalEnv` in `turbo.json`; `bun run dev:local`
  bypasses turbo and loads the file directly. A new variable must be added to the schema, the template and `turbo.json`.
- Sidecar env is read by `apps/research/app/config.py` and `apps/research/app/simulation/oasis_runner.py`; names in `INTEGRATIONS.md`.
- App behaviour (models, features, tool switches, the sidecar URL) is in `apps/chat/chat.config.ts`, validated by
  `apps/chat/lib/config-schema.ts`. It has no public URL on purpose: `apps/chat/lib/url.ts::getBaseUrl` reads `APP_URL`, then the
  Vercel URLs, then localhost.
- Models (`apps/chat/chat.config.ts`): gateway `openai`; `gpt-5.6-terra` for chat, the gate judge, PDF and the deep-research summarize,
  compress and final-report roles; `gpt-5.6-luna` for titles, extraction, anonymous users, the text, sheet and code document tools,
  and the researcher loop and status lines. Follow-up suggestions are enabled there but name no model, so they run on the OpenAI
  gateway default `gpt-5-nano` (`apps/chat/lib/ai/gateway-model-defaults.ts`, `openaiDefaults`).
  Embeddings use `text-embedding-3-small` at 1536 dimensions (`apps/chat/lib/embeddings/text.ts`).

**Build:**
- `apps/chat/package.json` scripts: `build` = `tsx lib/db/migrate && next build`; `prebuild` runs `scripts/check-env.ts`.
- `apps/chat/next.config.ts`, `apps/chat/tsconfig.json`, `apps/chat/postcss.config.mjs`, `apps/chat/biome.jsonc`,
  `apps/chat/drizzle.config.ts`, `apps/chat/vitest.config.ts`, `apps/chat/playwright.config.ts`, `apps/chat/evalite.config.ts`.
- `turbo.json` tasks: `dev`, `build` (outputs `.next/**`, `dist/**`, `build/**`), `lint`, `test`, `test:unit`, `test:types`, `fetch:models`.
- Sidecar: `apps/research/pyproject.toml` (hatchling, wheel includes `app`), `apps/research/Dockerfile` (stages `base` and `simulation`,
  non-root user, port 8099), `apps/research/.dockerignore`.
- Telemetry is off: `apps/chat/instrumentation.ts` is a no-op; CI sets `NEXT_TELEMETRY_DISABLED` and `TURBO_TELEMETRY_DISABLED`
  (`.github/workflows/ci.yml`).


## Platform Requirements

**Development:**
- Bun 1.3.14, Node 20.9 or newer, Docker (for `postgres` and `redis` services in `docker-compose.yml`), Python 3.11 with a venv for
  the sidecar, and an `OPENAI_API_KEY` in the repo-root `.env.local` for any model call.
- Start services with `docker compose up -d postgres redis`; plain `docker compose up -d` also builds and starts the sidecar on :8099.
  Ports are bound to `127.0.0.1` only (Postgres 5433, Valkey 6380, sidecar 8099, optional SearXNG 8888).
- The dev database is built with `db:push`; never run `db:migrate` against it (`.claude/rules/db.md`).

**Production:**
- Nothing is deployed. `apps/chat/vercel.json` targets Vercel (`bun install`, `bun run build`, one cron). The sidecar has to run privately
  next to the app (container from `apps/research/Dockerfile`) with `RESEARCH_SIDECAR_TOKEN` set on both sides; its address is the
  `researchSidecarUrl` key in `apps/chat/chat.config.ts`, not an env var.
- A production build applies migrations (`apps/chat/lib/db/migrate.ts` runs only when `VERCEL_ENV=production`).

---

*Stack analysis: 2026-11-12*
