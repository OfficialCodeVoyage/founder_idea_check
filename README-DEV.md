# Local development

> **First time here? Read [`GETTING-STARTED.md`](./GETTING-STARTED.md) instead.**
> It is the copy-paste path from clone to a working, signed-in app.
> This file is the reference for people who already have it running.

## Prerequisites

`bun` (the repo pins `packageManager: bun@1.3.1` — **pnpm will refuse to install**) and Docker.

```bash
curl -fsSL https://bun.sh/install | bash   # if not already installed
```

## Services

Postgres and Redis run in Docker on **offset ports** so they don't collide with
anything already running locally:

```bash
docker compose up -d postgres redis
```

That brings up `ic-pg` (Postgres 17 + pgvector, host port **5433**) and `ic-redis`
(host port **6380**). Both use named volumes, so your data survives a recreate.
Plain `docker compose up -d` also builds and starts the research sidecar.

> The Postgres image is `pgvector/pgvector:pg17`, not `postgres:17-alpine`. It is
> plain Postgres 17 plus the `vector` extension, which `ProjectFact.embedding`
> needs — on the stock image the first migration fails with
> `type "vector" does not exist`.

## Setup

```bash
bun install
bun run db:migrate      # creates the 17 tables
bun run db:seed         # idempotent demo user + Project + phase-1 ProjectPhase row
```

`bun run db:push` pushes `lib/db/schema.ts` straight to the database while iterating,
without generating a migration.

### Environment

`.env.local` lives at the **repo root** and is committed. There is **no**
`apps/chat/.env.local`, which matters more than it sounds:

- `drizzle.config.ts`, `playwright.config.ts` and `lib/db/migrate.ts` all call
  `config({ path: ".env.local" })` relative to `apps/chat`, so on their own they load
  **nothing**. Always go through the root `bun run db:*` / `dev:*` scripts, or wrap the
  command in `bunx dotenv-cli -e ../../.env.local -- …`.
- `scripts/check-env.ts` and `scripts/seed-demo.ts` load the root file themselves and
  work from either directory.

Only `DATABASE_URL` and `AUTH_SECRET` are strictly required; everything else is optional
and gated by `apps/chat/chat.config.ts`. To turn the AI on, add one line to the root
`.env.local` and restart:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
bun run dev:local        # http://localhost:3100   (PORT=3210 to override)
bun run dev              # http://localhost:3000   (turbo + worktree-ports)
```

Prefer `dev:local`. It bypasses turbo (whose strict env mode forwards only the variables
listed in `turbo.json`) and exports `APP_URL` matching the port it actually serves on.
That second part is load-bearing: better-auth builds `trustedOrigins` from `APP_URL` and
otherwise assumes `http://localhost:3000`, so on any other port every cookie-bearing POST
to `/api/auth` — **sign-out included** — returns `403 INVALID_ORIGIN`.

In production `APP_URL` is required outside Vercel: auth trusts only this deployment's own
URL (`APP_URL`, else on Vercel the project's production domain and `VERCEL_URL`), never
`appUrl` from `chat.config.ts`.

Both `dev` scripts run `check-env --dev`, which reports missing optional env vars as
warnings instead of exiting. `prebuild` still runs `check-env` strictly, so production
builds fail loudly.

### Sign in

```
http://localhost:3100/api/dev-login
```

There is a "Dev login" pill in the bottom-left of `/login` that hits the same route. It
upserts `dev@localhost`, writes a `session` row, signs the `better-auth.session_token`
cookie by hand, and 302s to `/`. It returns 404 unless `NODE_ENV === "development"`.

`chat.config.ts` enables **no** social provider. GitHub used to be enabled against
placeholder credentials, which rendered a "Continue with GitHub" button that redirected
to github.com with a bogus `client_id` and could never succeed. To use it for real:
create an OAuth app, set `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`, and flip
`authentication.github` back to `true`. `lib/auth.ts` also ignores placeholder-looking
credential values (`placeholder…`, `changeme…`, `your-…`) so a half-filled `.env.local`
cannot resurrect a dead button.

Anonymous visitors get plain chat only: `/project/...` is not a public route, and
`app/(chat)/api/chat/route.ts` skips the phase system block and the post-turn phase pass
for anonymous sessions. **Signing in is mandatory to exercise the phase workflow.**

## Tests

```bash
bun run test:types   # tsc across all workspaces        — 2 tasks
bun run lint         # biome / ultracite                — 2 tasks
bun run test:unit    # 297 pass / 3 skip / 0 fail
bun run test:e2e     # playwright; needs the DB up
```

`test:unit` breaks down as **208 chat + 58 thread + 31 cli** (the 3 skips are in the CLI
scaffolding suite). Those counts move as phases land — re-derive them with the `--force`
command below rather than trusting this line. The chat suite passes with **every** AI env var unset — model calls
sit behind injectable seams driven by `MockLanguageModelV3` from `ai/test`:

```bash
cd apps/chat && env -u AI_GATEWAY_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY bunx vitest run
```

Turbo cache replays are not runs. Use `--force` when you need real output:

```bash
bunx turbo run test:unit --force
```

`test:e2e` needs a one-time `cd apps/chat && bunx playwright install`; without the
browsers every test fails with `browserType.launch: Executable doesn't exist`. The suite
currently collects 4 anonymous smoke tests — `tests/auth.setup.e2e.ts` and
`tests/reasoning.setup.e2e.ts` are **dead code**: `playwright.config.ts` declares no
`setup` project, no `dependencies`, and no `storageState`, and their filenames match none
of the three `testMatch` regexes. There is no authenticated e2e coverage yet.

## Known rough edges

- A new user is funded with 50 credits ($0.50) and there is no top-up route or UI, so a
  long session eventually dead-ends on a bare 402. Bump it directly:
  `docker exec ic-pg psql -U postgres -d ideacheck -c 'update "UserCredit" set credits = 100000;'`
  (`UserCredit.credits` is CENTS: 100000 = $1000.00, and the sidebar shows `$1000.00`.)
- `lib/phases/runtime.ts` swallows post-turn failures in a bare `catch` so a bad model id
  leaves the rail permanently on `BLOCKED` with nothing in the UI.
- Switching `ai.gateway` without running `bun run fetch:models` leaves
  `lib/ai/models.generated.ts` pinned to the old gateway and the model picker empty.
  `check-env` warns about this; it does not fail.

## What was removed from upstream ChatJS

Tracked in `NOTICE` (Apache-2.0 §4(d) requires stating modifications):

- `apps/electron`, `apps/site`, `apps/docs` — whole workspaces
- All vendor telemetry: Langfuse, `@vercel/otel`, OpenTelemetry exporters.
  `createTelemetry` is a no-op; `instrumentation.ts` registers nothing.
  **This is load-bearing for the privacy claim — do not reintroduce.**
- The `retrieve-url` demo tool (required `FIRECRAWL_API_KEY`)
- Disabled in `chat.config.ts`: attachments, image generation, code execution
  sandbox, MCP connectors, web search, URL retrieval, deep research, desktop app,
  and all social auth providers.

Web search and deep research come back in Step 5 on top of the Python research
sidecar, not on a paid API key.
