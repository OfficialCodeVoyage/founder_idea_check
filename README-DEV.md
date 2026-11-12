# Local development

The reference for people who already have the app running. If you are starting from a fresh clone, read
[`GETTING-STARTED.md`](GETTING-STARTED.md) first: it is the same quick start, one step at a time.

## Prerequisites

- Bun 1.3.14 or newer. The repo pins `packageManager: bun@1.3.14`; npm and pnpm refuse to install it.
- Node.js 22 or newer (Next.js runs on 20.9, but the file-storage library, files-sdk, needs 22).
- Docker with Compose v2.
- bash: the scripts are written for it, so on Windows use WSL 2.
- Python 3.11 and [uv](https://docs.astral.sh/uv/), only if you run the research service outside Docker. It must be
  3.11: the simulation library pins `>=3.10,<3.12`.

## Ports and services

| What | Where | Started by | Notes |
| --- | --- | --- | --- |
| The app, `bun run dev:local` | `localhost:3100` | you | `PORT=3210 bun run dev:local` picks another port. |
| The app, `bun run dev` | `localhost:3000` plus 10 per worktree slot | you | Through turbo; see [Worktrees](#worktrees). |
| Postgres 17 with pgvector (`ic-pg`) | `127.0.0.1:5433` | Compose | Database `ideacheck`, user and password `postgres`. |
| Valkey, a Redis-compatible server (`ic-redis`) | `127.0.0.1:6380` | Compose | Optional; only used when `REDIS_URL` is set. |
| Research service | `127.0.0.1:8099` | Compose, or a virtualenv | No authentication, and its endpoints spend money. |
| SearXNG (`ic-searxng`) | `127.0.0.1:8888` | the opt-in overlay | AGPL-3.0, so it is not in the default stack. |

The ports are offset (5433, not 5432) so they cannot collide with a Postgres or Redis you already run, and every one is
bound to loopback. That is why Postgres can have the password `postgres` and Valkey none. If you ever publish one on
another interface, give it a real password in the same change.

```bash
docker compose up -d --wait            # Postgres, Valkey and the research service container
docker compose up -d postgres redis    # only the first two, when you run the research service yourself
docker compose stop                    # stop, keeping the data
docker compose down                    # remove the containers, keeping the data (named volumes)
docker compose down -v                 # also delete the database and Redis volumes
```

The Postgres image is `pgvector/pgvector:pg17`, not `postgres:17-alpine`: `ProjectFact.embedding` needs the `vector`
extension, and on a stock image the first migration fails with `type "vector" does not exist`.

## The research sidecar, in a container or a virtualenv

The service in `apps/research` has two ways to run. [`apps/research/README.md`](apps/research/README.md) owns its
sources and their policy; this is how to run it.

**The container.** `docker compose up -d --wait` builds it from `apps/research` and starts it. It is fixed to
`RESEARCH_HOSTED=false` and `RESEARCH_ENABLED_SOURCES=hackernews,web-keyless`, it does not read `.env.local`, and it
does not include persona simulation. That is enough for a first run.

**A virtualenv.** Use it for any other source, for SearXNG, or for simulation. The container and the virtualenv both
want port 8099, so stop the container first:

```bash
docker compose stop research
cd apps/research
uv venv --python 3.11 .venv
VIRTUAL_ENV="$PWD/.venv" uv pip install -e ".[dev]"
../../node_modules/.bin/dotenv -e ../../.env.local -- .venv/bin/python -m uvicorn app.main:app --port 8099
```

The last command loads the repo-root `.env.local`, so everything below is configured there. Uvicorn binds to
`127.0.0.1` by default; keep it that way, because the service has no authentication. Check what it will run and why
anything is off:

```bash
curl -s http://127.0.0.1:8099/v1/health
```

A listening port is not proof that it is configured: `sources[].operator_enabled` and `unknown_source_ids` are.

- **More sources.** Set `RESEARCH_ENABLED_SOURCES` in `.env.local`, for example `hackernews,web-keyless,github,arctic-shift`.
  The app reads the same variable and the service refuses a source it was not told to run, so set it once, in the file
  both read, and restart both. An unknown id is refused and reported at `/v1/health`.
- **GitHub** needs `GITHUB_TOKEN` as well as `github` in that list.
- **The Reddit archive (`arctic-shift`)** cannot search all of Reddit. The app chooses subreddits from your buyer, and
  with none to choose it says so. See the sidecar README.
- **SearXNG** gives the keyless web search a real backend instead of DuckDuckGo's HTML endpoint alone, which many
  networks answer with a challenge page. It is AGPL-3.0 software that this repository only configures, never copies:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.searxng.yml up -d searxng
  ```

  Then set `RESEARCH_SEARXNG_URL=http://127.0.0.1:8888` in `.env.local` and restart the sidecar. Plain
  `docker compose up -d` never starts it. If you modify SearXNG or run it for other people, read AGPL-3.0 section 13
  first.
- **Persona simulation** needs the heavy build: `VIRTUAL_ENV="$PWD/.venv" uv pip install -e ".[simulation]"` pulls torch
  and is several gigabytes, and until it is installed `/v1/simulate` reports `oasis-not-installed`. It also needs
  `OPENAI_API_KEY`, which the `dotenv` command above provides. The install brings in igraph (GPL-2.0-or-later) on your
  machine; this project publishes no simulation image, and you should not publish one without meeting the GPL for it
  ([`THIRD_PARTY-research.md`](THIRD_PARTY-research.md)).
- **Tests** need no network and no key: `.venv/bin/python -m pytest` and `.venv/bin/python -m ruff check app tests`.

## Environment

- **One env file.** `.env.local` at the repository root is the only one the app, the database tools, the evals and
  Playwright read. Copy it from [`.env.example`](.env.example), which lists every variable, what it does and which
  process reads it. There is no `apps/chat/.env.local` and no second example file.
- **Run the migrator through the root script.** `lib/db/migrate.ts` looks for `.env.local` relative to `apps/chat`,
  where there is none, so on its own it loads nothing; the root `bun run db:migrate` wraps it with `dotenv`, and so do
  the other root `db:*` scripts and `dev:local`. `drizzle.config.ts`, `scripts/seed-demo.ts`, the evals and the
  Playwright config resolve the root file from their own location, and `scripts/check-env.ts` does when it is run from
  `apps/chat`.
- **Turbo drops variables you did not list.** `bun run dev` and `bun run build` go through turbo, whose strict env mode
  passes a task only the variables in `globalEnv` in `turbo.json`; `dev:local` bypasses turbo. A variable added to
  `apps/chat/lib/env-schema.ts` therefore also goes in `globalEnv`, and `lib/env-schema.test.ts` fails when one is
  missing. This once made a research source work under `dev:local` and refuse under `dev` (Incident 10 in
  [`docs/INCIDENTS.md`](docs/INCIDENTS.md)).
- **The public URL** comes from `lib/url.ts::getBaseUrl`: `APP_URL`, then on Vercel the project's production domain
  (production only), then `VERCEL_URL`, then `http://localhost:3000`. Authentication trusts only that origin, which is
  why `dev:local` exports `APP_URL` for the port it serves on, and why a cookie-bearing POST from any other address
  fails with `403 INVALID_ORIGIN`. Outside Vercel, `APP_URL` is required in production. `chat.config.ts` has no URL on
  purpose.
- **Checks at start-up.** Both dev scripts run `check-env --dev`, which reports a missing optional variable as a
  warning; `prebuild` runs it strictly, so a production build fails loudly instead.
- **Never set `PLAYWRIGHT`, `PLAYWRIGHT_TEST_BASE_URL` or `CI_PLAYWRIGHT` outside a test run.** Any of them switches
  authentication off.

`RESEARCH_SIDECAR_TOKEN` stays unset locally: the research sidecar then serves loopback
callers only, which is the app on the same machine. Set it, to the same value in the app's
and the sidecar's environment, as soon as the app reaches the sidecar over a network (see
`apps/research/README.md`, Configuration).

## File storage

Attachments and generated images and videos are stored in Vercel Blob through files-sdk
(`apps/chat/lib/storage-provider.ts`), as **private** blobs (`access: "private"`). A public blob can be read by anyone
who has the store id and the key, straight from the Blob CDN, around the access checks in `/api/files/content`. A
private blob is read only with the app's own credentials, so that route is the only way in. The Blob store must accept
private blobs. Nothing is deployed yet, so no stored file is at risk today. Two consequences matter for a deployment:

- **Blobs uploaded as public before this change will not load.** In private mode files-sdk reads every file with
  `blob.get(key, { access: "private" })` and reports anything that does not come back that way as `NotFound`, so a
  store that already holds public blobs (one used by this app before the switch, or by upstream ChatJS) serves them as
  404. One-off fix, before going live on such a store: create a private Blob store; copy every blob into it under the
  **same pathname** (list the old store, download each blob from its public URL, `put` it with `access: "private"`,
  `addRandomSuffix: false` and its content type); point `BLOB_READ_WRITE_TOKEN` / `BLOB_STORE_ID` at the new store;
  then delete the old one. Messages store `/api/files/content?key=<pathname>`, so keeping the pathnames keeps every
  link working.
- **No byte ranges.** Private blobs report no range support, so `/api/files/content` answers `Accept-Ranges: none` and
  always sends the whole file. Images and PDFs are unaffected. Safari will not play a `<video>` whose source refuses
  range requests, so generated videos (off in `chat.config.ts`) need range support added before video generation is
  turned on.

## Run

```bash
bun run dev:local        # http://localhost:3100  (PORT=3210 to change it)
bun run dev              # http://localhost:3000 plus 10 per worktree slot, through turbo
```

Prefer `dev:local`: it bypasses turbo and sets `APP_URL` to the port it serves on. It takes that port only from
`PORT` and refuses to start when you pass one (`-p`, `--port`, `--port=…`): Next takes the last port it is given, so
`bun run dev:local --port 4000` would listen on 4000 while `APP_URL`, the sign-in link and better-auth's trusted
origin stayed on 3100, and every sign-in or sign-out POST would fail with 403 `INVALID_ORIGIN`.

### Sign in

Open `http://localhost:3100/api/dev-login`, or use the "Dev login" button on `/login`. Either creates `dev@localhost`,
signs the session cookie and redirects to `/`. The route answers 404 unless `NODE_ENV` is `development`, and unless
`IC_DEV_SERVER_LOCALHOST_ONLY=1`. Only the scripts that bind the server to this machine set that variable:
`dev-local.sh` and the chat `dev` / `dev:inspect` scripts start `next dev --hostname localhost` with it through
`apps/chat/scripts/next-dev-localhost.sh`, so other machines on your network cannot reach the server. These scripts
refuse to start when you pass a hostname (`-H`, `--hostname`, `--hostname=…`): Next takes the last one, so
`bun run dev --hostname 0.0.0.0` would listen on every interface with the marker still set. To serve on your network,
run `next dev` yourself; the route is then off. A bare `next dev` listens on every interface and has no marker, so the
route is off there. Do not set the variable yourself. Behind the marker the route also answers 404
unless the request's `Host` is a loopback name and its `X-Forwarded-For` is a loopback address. Those headers can be
forged, so they only turn away callers who do not forge them; the bind is what protects you. Open the app as
`localhost`, not by the machine's LAN address.

Every social provider is off in `chat.config.ts`: a button for a provider with no real credentials would redirect to
a sign-in that cannot succeed. To use one, create the OAuth app, set its two variables in `.env.local` and set
`authentication.<provider>: true`. `lib/auth.ts` ignores placeholder-looking values (`placeholder...`, `changeme...`,
`your-...`), so a half-filled `.env.local` cannot bring a dead button back.

Anonymous visitors get plain chat only: `/project/...` needs a session, and the phase system block and the post-turn
phase pass are skipped for them. Signing in is how you exercise the phase workflow.

## Worktrees

Several git worktrees can run side by side. `bun run dev:info` prints this worktree's app URL, so use it instead of
assuming a port. Set `CHATJS_DEV_SLOT` in `.env.worktree.local`, which Git ignores, to reserve a stable range of ten
ports; the slot name is inherited from the code this fork started from and is configured in `.worktree-env.json`. The
app is at offset 0, so slot 0 is port 3000, slot 1 is 3010, and so on. `dev:local` ignores the slot and uses `PORT`,
which defaults to 3100, so two worktrees running `dev:local` need different `PORT` values.

The Docker services are not per worktree: the container names and ports are fixed, so every worktree shares one
database unless you point its `DATABASE_URL` somewhere else.

## Database

- **A new database** is built with `bun run db:migrate`. That is the supported path for anyone who clones the repo.
  `db:migrate` forces `VERCEL_ENV=production` because the migrator skips itself otherwise, and `bun run build` runs the
  same migrator first.
- **Changing the schema:** edit `apps/chat/lib/db/schema.ts`, run `bun run db:generate`, review the SQL, and write any
  CHECK constraint by hand (drizzle-kit once recorded some without emitting them). Replay the new migration on a
  throwaway `pgvector/pgvector:pg17` container, run `bun run db:check` from `apps/chat`, and update
  [`docs/DATABASE.md`](docs/DATABASE.md) in the same commit. The recipe and the rules are in that file.
- **Never run `db:migrate` against a database that was built with `db:push`.** `push` leaves the migration bookkeeping
  incomplete, and the migrator applies every pending file in one transaction, so the first change `push` already made
  aborts the whole batch. The maintainers' own dev database was built that way: apply a new migration to it with
  `docker exec -i ic-pg psql -U postgres -d ideacheck < <file>.sql`. If you use `db:push` to experiment, treat the
  database as throwaway and reset it with `docker compose down -v`.
- **Look at it:** `docker exec -it ic-pg psql -U postgres -d ideacheck`.
- **Demo data:** `bun run db:seed` is optional and idempotent. It creates the `dev@localhost` user, a balance row and a
  project called Demo idea with phase 1 active.

## Checks

```bash
bun run verify       # lint + type-check (apps/chat, packages/thread), ruff when apps/research/.venv exists
bun run test:unit    # vitest in apps/chat, bun test in the packages and the worktree-port script
bun run test:types   # tsc --noEmit in every workspace; NOT while a dev server is running
bun run lint
```

- `bun run verify` is the one to run before you say work is done. It is safe beside a dev server, and it ends with
  `verify: all checks passed`. `test:types` is not safe beside one: it deletes `apps/chat/.next/dev/types`.
- The unit tests need no database, no network and no API key. Model calls sit behind injectable seams driven by
  `MockLanguageModelV3`, so this passes with every AI variable unset:

  ```bash
  cd apps/chat && env -u AI_GATEWAY_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY ./node_modules/.bin/vitest run
  ```

  Inside `apps/chat`, use that or `bun run test:unit`, never a bare `bun test`: that is Bun's own runner, not vitest.
  Turbo replays a cached result as if it were a run, so use `bunx turbo run test:unit --force` when you need real
  output.
- `bun run test:e2e` is the Playwright suite. It needs the Docker database and a one-time
  `cd apps/chat && bunx playwright install`, and it is not part of CI.
- `bun run build` only right before a push, never while iterating: it runs `check-env` strictly and the migrator, then
  `next build`.
- CI runs `verify`, the unit tests, the sidecar tests and a test-integrity check on every pull request; the one required
  check is `ci-success`, and a pull request is squash-merged into `main`.
  [`CONTRIBUTING.md`](CONTRIBUTING.md) has the details.

## What costs money

- Chat turns, the phase gate's judge, fact extraction, fact embeddings and research all call OpenAI with your key.
- `cd apps/chat && bun run eval:gate` runs the gate calibration against the real judge: about 24 calls on the chat
  model, `gpt-5.6-terra`. Run it deliberately, never as a habit.
- The app also keeps a local spending cap, `UserCredit.credits`, in cents. A new user starts with 50 and nothing tops it
  up. Raise it with
  `docker exec ic-pg psql -U postgres -d ideacheck -c 'update "UserCredit" set credits = 2000;'`.

## Rough edges

- There is no credit top-up screen, so a long session ends in a bare `Insufficient credits` (HTTP 402) until you raise
  the balance as above.
- When the gate cannot run (a missing or wrong key, a model id the gateway does not serve) the phase strip says
  `no verdict for this turn` or shows a fail-closed BLOCK. The reason is in the log of the terminal running the app.
- Switching `ai.gateway` in `chat.config.ts` without running `bun run fetch:models` leaves
  `lib/ai/models.generated.ts` pinned to the old gateway and the model picker empty. `check-env` warns about it and does
  not fail. The model ids in `chat.config.ts` are typed per gateway too.
- The sidecar container and a virtualenv sidecar both use port 8099. Stop one before you start the other, and use
  `docker compose up -d postgres redis` rather than a plain `up -d` while the virtualenv one runs.

## Where the rest is written down

| For | Read |
| --- | --- |
| how it is put together, and where to add things | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| the schema, constraints and migration rules | [`docs/DATABASE.md`](docs/DATABASE.md) |
| why a hard-to-reverse choice was made, and what has gone wrong | [`docs/ADR/`](docs/ADR/README.md), [`docs/INCIDENTS.md`](docs/INCIDENTS.md) |
| the words the code uses | [`CONTEXT.md`](CONTEXT.md) |
| the research sources and their policy | [`apps/research/README.md`](apps/research/README.md) |
| contributing, security, what was copied from where | [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md), [`NOTICE`](NOTICE) |
