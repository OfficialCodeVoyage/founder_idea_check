# Getting started

From `git clone` to your first conversation with the gate, one step at a time. The commands are the same ones the
[README](README.md) lists; this page adds what you should see after each one, and what to do when you do not.

Everything runs on your machine. Plan on about 15 minutes, most of it the first Docker build, and on an OpenAI API key:
the app calls OpenAI for every answer.

## What you need

| You need | Check it with | Notes |
| --- | --- | --- |
| Bun 1.3.14 or newer | `bun --version` | The repo pins `packageManager: bun@1.3.14`. npm and pnpm refuse to install it. |
| Node.js 22 or newer | `node --version` | Next.js runs on 20.9, but the file-storage library (files-sdk) needs 22. |
| Docker with Compose v2 | `docker compose version` | Postgres, Redis and the research service run in containers. |
| An OpenAI API key | | On an account with billing enabled. |
| macOS, Linux or WSL 2 | | The scripts are written for bash. |

If Bun is missing:

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
```

## 1. Get the code

```bash
git clone https://github.com/OfficialCodeVoyage/founder_idea_check.git
cd founder_idea_check
bun install
```

Run every command from here on in the repository root unless a step says otherwise.

## 2. Set up your environment file

```bash
cp .env.example .env.local
```

Open `.env.local` and set two values:

- `AUTH_SECRET`: any long random string. `openssl rand -base64 32` prints one.
- `OPENAI_API_KEY`: from <https://platform.openai.com/api-keys>.

Leave `DATABASE_URL` as it is: it already points at the Postgres that the next step starts. Everything else in the file
is optional and commented out.

`.env.local` lives at the repository root and nowhere else. There is no `apps/chat/.env.local`, and every script in
this guide loads the root file for you. The file is gitignored: never commit it.

## 3. Start Postgres, Redis and the research service

```bash
docker compose up -d --wait
```

The first run builds the research service image, which takes a few minutes. Compose returns when all three containers
are healthy. `docker compose ps` should list three services:

| Service | What it is | Where |
| --- | --- | --- |
| `ic-pg` | Postgres 17 with the pgvector extension | `127.0.0.1:5433` |
| `ic-redis` | Valkey, a Redis-compatible server | `127.0.0.1:6380` |
| research | the Python service that gathers demand signals | `127.0.0.1:8099` |

All three listen on your own machine only. The ports are offset (5433, not 5432) so they do not collide with a
Postgres or Redis you already run. Data is kept in named volumes, so it survives a stop or a recreate.

Check the research service:

```bash
curl -s http://127.0.0.1:8099/v1/health
```

You should see `"ok": true` and a `sources` list in which `hackernews` and `web-keyless` have
`"operator_enabled": true`. Those are the two sources that need no key; see [What the research can do](#what-the-research-can-do).

> The Postgres image is `pgvector/pgvector:pg17`, not the stock `postgres` image. It is Postgres 17 plus the `vector`
> extension that fact embeddings need. On a stock image the schema step fails with `type "vector" does not exist`.

## 4. Create the database schema

```bash
bun run db:migrate
```

You should see `Running migrations...` and then `Migrations completed in <n> ms`. A Postgres `NOTICE` that an identifier was truncated to 63 bytes is expected and
harmless (see [`docs/DATABASE.md`](docs/DATABASE.md)). To look at what it made:

```bash
docker exec ic-pg psql -U postgres -d ideacheck -c '\dt'
```

The list includes `Project`, `ProjectFact` and `ProjectPhaseAttempt`. `db:migrate` is the right command for a new
database. Do not use `db:push` to create one; [`docs/DATABASE.md`](docs/DATABASE.md) says why.

## 5. Start the app

```bash
bun run dev:local
```

You should see an environment check, a line naming the address, and then Next.js reporting that it is ready:

```
▶ http://localhost:3100   (sign in: http://localhost:3100/api/dev-login)
```

The check prints warnings rather than stopping, and one is expected: it tells you no social sign-in provider is enabled
and to use `/api/dev-login`, which is what step 6 does. If it lists `aiGateway (openai): OPENAI_API_KEY`, the key is
missing or empty in `.env.local`. The first page takes a while to compile.

Use `dev:local`, not `next dev` by hand. It loads the root `.env.local` directly (turbo, which `bun run dev` goes
through, passes a task only the variables listed in `turbo.json`), and it sets `APP_URL` to the address it serves on.
The app trusts only that address, so on any other one signing out and other authenticated form posts fail with
`403 INVALID_ORIGIN`. Port 3100 is the default; `PORT=3210 bun run dev:local` picks another.

## 6. Sign in

Open <http://localhost:3100/api/dev-login>.

That is the whole login. It creates a local user, `dev@localhost`, signs a session cookie and sends you to the home
page. It exists only while the app runs in development (it answers 404 otherwise), and only when the app was started
with `bun run dev:local` or `bun run dev`: those start the server on `localhost` only, so other devices on your Wi-Fi
cannot reach it. Started any other way (for example a bare `next dev`, which listens on your whole network), the route
answers 404. Use `localhost` in the address bar, not `127.0.0.1`.

No "Continue with GitHub" or Google button is shown, on purpose: all social providers are off. To use real GitHub
sign-in, create an OAuth app, put `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` in `.env.local`, and set
`authentication.github: true` in `apps/chat/chat.config.ts`.

## 7. Start a project

1. In the sidebar choose **New project**, give it a name and create it. You land on a new-chat screen for that project.
2. Describe your idea in the message box and send it. Start with the problem: who has it, how often, what they do about
   it today. The assistant asks follow-up questions.
3. Above the conversation a strip shows `Phase 1 of 8` and a badge. A new project reads **NOT ASSESSED**. After each
   answer the gate runs in the background; the strip says `checking…` for up to about half a minute, and then the badge
   becomes **BLOCKED**, **THIN** or **READY**. The verdict card at the foot of the conversation lists what is missing
   and asks the next question. When the only thing missing is fieldwork you have not done yet, it asks how you will
   collect it, not for numbers.
4. Inside a project the sidebar adds four screens:
   - **Phases**: the eight phases, their exit criteria, and every refusal the gate has given you.
   - **Facts**: what the app has recorded, with its confidence and who asserted it. You can correct a value, delete a
     fact, or add one the current phase records, for example after interviews you ran offline. Facts you correct or
     add are marked as yours. Adding one does not advance the phase.
   - **Canvas**: facts, persona and the tasks that would unblock the current phase.
   - **Simulation**: persona reactions to a pitch. This needs the heavy research build; see [README-DEV.md](README-DEV.md).
5. **Export repo**, in the strip, opens a dialog that previews every generated file and lets you download them one at a
   time. It works from the first fact on, and says in writing what is missing.

## 8. Raise your credit balance

The app keeps a spending cap as a balance in your local database, in cents. A new user starts with 50 (that is $0.50)
and there is no top-up screen, so a long session ends with `Insufficient credits` (HTTP 402). Raise it:

```bash
docker exec ic-pg psql -U postgres -d ideacheck -c 'update "UserCredit" set credits = 2000;'
```

That sets the balance to 2000 cents, $20.00; use any number you like. The balance is an estimate of what OpenAI will
bill you, not what it does bill: your OpenAI account is the real meter.

## What the research can do

Out of the box the research service runs two sources: Hacker News, and a keyless web search that asks DuckDuckGo. Hacker
News mostly holds developers and startup people. DuckDuckGo's HTML endpoint is often answered with a challenge page on
a home or office network, and then the app reports that lane as blocked, not as "nothing found". Treat what comes back
as leads, not proof, especially if your buyer is not a developer.

To widen it (a SearXNG for general web search, a GitHub token, the Reddit archive, persona simulation), see "The
research sidecar, in a container or a virtualenv" in [`README-DEV.md`](README-DEV.md). The sources and their policy are
in [`apps/research/README.md`](apps/research/README.md).

## What works without a key

The app boots, you can sign in, create projects and browse every screen, and `bun run verify` and
`bun run test:unit` run with every AI variable unset. Anything that calls a model needs the key: sending a message, the
gate's judge, fact extraction, titles, follow-up suggestions and research.

## Stop, restart, reset

- `Ctrl-C` stops the app. Start it again with `bun run dev:local`.
- `docker compose stop` stops the three services; `docker compose up -d --wait` starts them again.
- `docker compose down` removes the containers and keeps your data.
- `docker compose down -v` also deletes the database and Redis volumes. After it, run `bun run db:migrate` again.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `bun install` refuses or complains about the package manager | npm or pnpm, or an older Bun | Install Bun 1.3.14 or newer. |
| `port is already allocated` on 5433, 6380 or 8099 | something else is using it | Stop that, then `docker compose up -d --wait`. |
| `type "vector" does not exist` during `db:migrate` | the Postgres on port 5433 is not the pgvector image | Use the one from `docker compose`; see step 3. |
| `Invalid environment variables` naming `AUTH_SECRET` | it is blank in `.env.local` | Set it (step 2) and start again. |
| `EADDRINUSE :::3100` | something else is on the port | `PORT=3210 bun run dev:local`. |
| Signing out returns `403 INVALID_ORIGIN` | you are browsing at `127.0.0.1`, or at a port the app was not started for | Use `localhost` and the address `dev:local` printed. |
| A project page sends you back to the home page | you are not signed in | Open <http://localhost:3100/api/dev-login>. |
| The badge stays **NOT ASSESSED**, or says `no verdict for this turn` | the gate could not run, usually a missing or wrong `OPENAI_API_KEY` | Read the error in the terminal running `dev:local`, fix the key, send another message. |
| `Insufficient credits` (402) | the local balance is used up | Step 8. |
| Research lanes report as blocked or refused | the default sources are limited | See [What the research can do](#what-the-research-can-do). |
| `DATABASE_URL is not defined` from the migrator | you ran it inside `apps/chat`, which has no env file of its own | Run `bun run db:migrate` from the repository root. |

## Commands

| Command | What it does |
| --- | --- |
| `bun run dev:local` | dev server on port 3100 (`PORT=` to change it), env loaded, `APP_URL` set |
| `bun run dev` | dev server on port 3000 through turbo and the worktree port wrapper |
| `bun run db:migrate` | apply the migrations to a new database |
| `bun run db:seed` | optional: creates the dev user, a balance row and a project called Demo idea |
| `bun run verify` | lint and type-check; run it before you say work is done |
| `bun run test:unit` | the TypeScript unit tests |
| `bun run test:types` | `tsc --noEmit` everywhere; do not run it while a dev server is running |
| `bun run lint` | Biome through Ultracite |

Ports, worktrees, the research service in a virtualenv, tests and the development database are in
[`README-DEV.md`](README-DEV.md).
