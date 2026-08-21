# Getting started

From `git clone` to a running app you can click through — **without an API key** —
in about five minutes, plus one clearly-marked step to turn the AI on.

Everything below is copy-paste. Commands run from the repo root unless stated.

---

## 0. Prerequisites

`bun` and Docker. The repo pins `packageManager: bun@1.3.1`; **pnpm and npm will refuse to install.**

```bash
curl -fsSL https://bun.sh/install | bash   # if bun is not already installed
export PATH="$HOME/.bun/bin:$PATH"
```

---

## 1. Services (Postgres + Redis)

Both run on **offset ports** so they cannot collide with anything already on 5432/6379.

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

Stop them with `docker compose stop`. `docker compose down` removes the
containers but keeps the `pgdata` / `redisdata` volumes — your data stays put.

---

## 2. Install

```bash
bun install
```

---

## 3. Environment

`.env.local` at the **repo root** is committed and already has everything needed to boot:
`DATABASE_URL`, `AUTH_SECRET`, `REDIS_URL`, `MCP_ENCRYPTION_KEY`.

> There is **no** `apps/chat/.env.local`. The root file is the only one. Every script in
> this guide loads it for you; a bare `bun scripts/whatever.ts` inside `apps/chat` will not.

Nothing to edit yet. The AI key comes in step 7.

---

## 4. Database

```bash
bun run db:migrate      # creates the 17 tables
```

Iterating on `lib/db/schema.ts` instead of writing a migration? Use `bun run db:push`.
(Both wrap `dotenv -e .env.local`, which is required — `drizzle.config.ts` on its own
resolves `.env.local` relative to `apps/chat`, where no such file exists.)

---

## 5. Seed the demo data

```bash
bun run db:seed
```

Creates, idempotently (run it as often as you like):

| row | value |
| --- | --- |
| `user` | `dev@localhost` — **the same account `/api/dev-login` signs you into** |
| `UserCredit` | 50 credits ($0.50), the default for a new user |
| `Project` | `Demo idea` |
| `ProjectPhase` | phase 1 `problem-validation`, `status=active`, no verdict yet |

It prints the project URL. Copy it — you need it in step 6.

---

## 6. Run the app

```bash
bun run dev:local
```

Serves on **http://localhost:3100** (port 3000 is usually taken by something else).
Override with `PORT=3210 bun run dev:local`.

Use `dev:local`, not `next dev` by hand — the script does two things you cannot skip:

- loads the repo-root `.env.local` directly, **bypassing turbo**, whose strict env mode
  forwards only the variables listed in `turbo.json`;
- exports `APP_URL` matching the port it actually serves on. better-auth builds
  `trustedOrigins` from `APP_URL` and otherwise assumes `http://localhost:3000` — on any
  other port every cookie-bearing POST to `/api/auth`, **sign-out included**, fails with
  `403 INVALID_ORIGIN`.

`bun run dev` (the turbo path, pinned to port 3000) also works and also sets `APP_URL`.

### Sign in

Open **http://localhost:3100/api/dev-login**.

That is the whole login. It upserts `dev@localhost`, writes a `session` row, signs the
`better-auth.session_token` cookie itself, and redirects to `/`. It returns `404` unless
`NODE_ENV === "development"`, so it does not exist in a production build.

There is also a **"Dev login"** pill in the bottom-left of `/login` that does the same thing.

> **No OAuth button is shown, and that is deliberate.** `chat.config.ts` previously
> enabled GitHub while `.env.local` held placeholder credentials, so the login page
> advertised a "Continue with GitHub" button that redirected to github.com with a bogus
> `client_id` and could never succeed. To use real GitHub sign-in: create an OAuth app,
> put `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` in `.env.local`, and set
> `authentication.github: true` in `apps/chat/chat.config.ts`.
> (Placeholder-looking values are ignored by `lib/auth.ts` on purpose, so a half-filled
> `.env.local` can never resurrect a dead button.)

### See the phase rail

Open the project URL that `db:seed` printed:

```
http://localhost:3100/project/<the-uuid-from-step-5>
```

The rail renders **`Phase 1 of 8 · BLOCKED · "no assessment yet — keep going"`**. That is
the correct, honest state before any model has judged anything — and it renders with no
API key at all.

You can also make your own project from the sidebar ("New project"), which needs a
signed-in session — anonymous visitors are redirected from `/project/...` to `/login`.

---

## 7. ⭐ The one key step

Open the repo-root `.env.local` and add one line:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

Restart the dev server (`Ctrl-C`, then `bun run dev:local`). **That is it.** No config
edit, no migration, no `bun install`, no second key.

You should see the boot warning `aiGateway (anthropic): ANTHROPIC_API_KEY` disappear.

---

## What works **without** a key

- `docker`, `bun install`, `db:migrate`, `db:push`, `db:seed`
- The dev server boots. Missing keys are warnings, not a hard exit.
- Sign-in (`/api/dev-login`), sidebar, project creation, project pages
- The phase rail, rendering the real `phase.getState` tRPC response from the database
- `bun run test:types`, `bun run lint`, `bun run test:unit` — the entire unit suite runs
  with **every** AI env var unset. Model-dependent code paths are exercised through an
  injectable seam with `MockLanguageModelV3`.
- `bun run test:e2e` — the Playwright smoke tests run anonymously (one-time
  `cd apps/chat && bunx playwright install` first; without it every test fails with
  `browserType.launch: Executable doesn't exist`, which is a missing browser, not a bug)

## What needs the key

Anything that calls a model:

- Sending a chat message
- The **phase gate judge** and the **fact extractor** (`lib/phases/runtime.ts`) — these
  run after each assistant turn and are what move the rail off `BLOCKED`
- Chat title generation, followup suggestions

Until the key is present, the rail stays on `BLOCKED · "no assessment yet — keep going"`.

---

## Troubleshooting

| symptom | cause | fix |
| --- | --- | --- |
| `EADDRINUSE :::3100` | something else on the port | `PORT=3210 bun run dev:local` |
| Sign-out returns `403 INVALID_ORIGIN` | app served on a port that `APP_URL` does not match | use `bun run dev:local`, which exports `APP_URL` for you |
| `/project/...` bounces to `/login` | not signed in | http://localhost:3100/api/dev-login |
| Rail never leaves `BLOCKED` | no `ANTHROPIC_API_KEY`, or a model id the gateway does not serve | step 7; then check the dev-server log |
| `Insufficient credits` (402) | a new user is funded with 50 cents and there is no top-up UI | `docker exec ic-pg psql -U postgres -d ideacheck -c 'update "UserCredit" set credits = 100000;'` — the column is CENTS, so this is $1000.00; the sidebar renders it as `$1000.00` |
| `DATABASE_URL is not set` from a script | you ran it inside `apps/chat` without the root env | use the root `bun run db:*` scripts |
| Empty model picker | `lib/ai/models.generated.ts` was built for a different gateway | `bun run fetch:models` |

---

## Command reference

| command | what it does |
| --- | --- |
| `bun run dev:local` | dev server on 3100 (`PORT=` to override), env loaded, `APP_URL` set |
| `bun run dev` | dev server on 3000 via turbo |
| `bun run db:migrate` | apply migrations |
| `bun run db:push` | push `schema.ts` straight to the DB (dev only) |
| `bun run db:seed` | idempotent demo user + project + phase row |
| `bun run test:types` | `tsc --noEmit` across all workspaces |
| `bun run test:unit` | vitest + bun test across all workspaces |
| `bun run lint` | biome / ultracite |
