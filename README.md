<div align="center">

<img src="apps/chat/app/icon.svg" alt="Founder Idea Check" width="64" height="64">

# Founder Idea Check

Test a startup idea before you build it.

</div>

<br />

Founder Idea Check is a chat app for founders. You describe an idea and it walks you through eight validation
phases. After every answer it checks what you have actually established, and it will not move you to the next phase
on enthusiasm alone: each phase has exit criteria, and a gate written as plain code refuses to pass them without
evidence. When you are done, the project exports as a folder of documents that a coding agent can start from.

It runs on your own machine. There is no hosted version.

## How it works

**Eight phases.** Problem validation, solution shaping, user personas, demand verification, positioning and
differentiation, MVP scope and build plan, pricing and unit economics, go-to-market and launch. Each one has its own
questions and its own exit criteria.

**Facts.** After each turn the app pulls the claims you have established out of the conversation, each with a
confidence and the words you used. The facts are what the gate, the persona and the export are built on.

**A gate that fails closed.** A language model judges each exit criterion as met, partial, unmet or "could not tell".
The gate, which is code and not the model, turns those labels into PASS, WARN or BLOCK. "Could not tell" never counts
as met, and an error from the judge is a BLOCK. When the only thing missing is something fieldwork has to supply, such
as interview results, the app does not ask you to make numbers up: it asks how you will collect them. Every refusal is
kept, so you can read back why you were stopped.

**Your own evidence.** You can correct a fact or add one by hand, for example after interviews you ran offline. It is
marked as yours wherever it is used, and typing a fact does not advance a phase: the gate still judges it.

**Research.** A small Python service gathers public demand signals (posts and threads where people describe the
problem) and the app shows what each source did, including the ones that refused or found nothing. It stores no
author names.

**Simulated customers.** A persona can be put in front of your pitch and asked to react. That is a way to generate
hypotheses. It never counts as evidence.

**Export.** At any point after the first fact, you can open the export dialog, read every file in it and download them
one at a time: a product requirements document, a roadmap, the facts with who asserted each, open questions, a note
per phase, the persona, and a `CLAUDE.md` and `AGENTS.md` for the coding agent. Together they are a documentation
folder with no application code and no licence file, because nothing in the eight phases chooses a technology or a
licence for you. Gaps are written down as gaps.

## What the research can and cannot do today

Read this before you trust a research result.

- **Hacker News is the only source that works with no setup.** It is a good place to find developers and startup
  people and a poor place to find anyone else.
- **General web search with no setup asks DuckDuckGo's HTML endpoint**, which many networks answer with a challenge
  page. The app then reports that the lane was blocked. It does not report "nothing found". To get general web search
  back, run the optional SearXNG container (see [`README-DEV.md`](README-DEV.md)).
- **GitHub needs a personal access token** in `GITHUB_TOKEN`, and has to be switched on in `RESEARCH_ENABLED_SOURCES`.
- **Reddit history comes from the Arctic Shift archive.** It is off by default, it cannot search all of Reddit, and it
  works only in subreddits the app can choose for your buyer. If it cannot choose any, it says so.
- **Simulated customers need a separate, heavy build** of the research service (several gigabytes). The default
  container does not include it.

If your buyer is not a developer, expect thin research until you switch on SearXNG and the Reddit archive. Treat
what comes back as leads to follow up, not as proof. The sources, their defaults and the policy behind them are in
[`apps/research/README.md`](apps/research/README.md).

## Quick start

You need [Bun](https://bun.sh) 1.3.14 or newer, Node.js 20.9 or newer, Docker with Compose v2, and an
[OpenAI API key](https://platform.openai.com/api-keys) on an account with billing enabled. The scripts are written for
bash, so use macOS or Linux, or WSL 2 on Windows.

```bash
git clone https://github.com/OfficialCodeVoyage/founder_idea_check.git
cd founder_idea_check
bun install
cp .env.example .env.local
```

Open `.env.local` and set two values: `AUTH_SECRET` (generate one with `openssl rand -base64 32`) and
`OPENAI_API_KEY`. Leave `DATABASE_URL` as it is. Then:

```bash
docker compose up -d --wait   # Postgres with pgvector, Valkey (Redis-compatible), and the research service
bun run db:migrate            # creates the database schema
bun run dev:local             # starts the app on http://localhost:3100
```

The first `docker compose` run builds the research service image, which takes a few minutes. Open
<http://localhost:3100/api/dev-login> to sign in as a local development user, choose **New project** in the sidebar,
name it, and describe your idea in the message box on the page that opens. [`GETTING-STARTED.md`](GETTING-STARTED.md)
walks through the same steps one at a time, with what you should see and what to do when you do not.

Use `localhost`, not `127.0.0.1`: the app trusts only the address it was started for, and from any other address
signing out and other authenticated form posts fail with a 403.

## What it costs and what leaves your machine

- Every chat turn, the gate's judge, fact extraction, fact embeddings and research call OpenAI with your key, so you
  pay OpenAI directly. The chat and the gate use `gpt-5.6-terra`, titles and fact extraction use `gpt-5.6-luna`, and
  research uses both.
- The app keeps its own spending cap as a credit balance in your local database. A new account starts with about
  $0.50 and there is no top-up screen, so you will want to raise it; [`GETTING-STARTED.md`](GETTING-STARTED.md) shows
  how.
- Your projects, chats and facts live in the Postgres container on your machine. What leaves it: your messages and
  facts go to OpenAI to produce answers, and research queries go from your machine to the public sources you have
  enabled. The app sends no analytics and no telemetry.

## More

- [`GETTING-STARTED.md`](GETTING-STARTED.md): the quick start, one step at a time, with troubleshooting.
- [`README-DEV.md`](README-DEV.md): ports, running the research service yourself, worktrees, checks, tests and the
  development database.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): how it is put together and where to add things.
- [`docs/DATABASE.md`](docs/DATABASE.md): the schema and the migration rules.
- [`docs/ADR/`](docs/ADR/README.md) and [`docs/INCIDENTS.md`](docs/INCIDENTS.md): why it is built this way and what has gone wrong.
- [`CONTEXT.md`](CONTEXT.md): the words this project uses (phase, gate, criterion, fact, signal).
- [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Built on ChatJS

Founder Idea Check is a fork of [ChatJS](https://github.com/FranciscoMoretti/chat-js) by Francisco Moretti, an
Apache-2.0 chat application framework. The chat interface, authentication and much of the plumbing come from it.
What was changed and added is listed in [`NOTICE`](NOTICE); code taken from other projects, with its licence, is
recorded in [`THIRD_PARTY.md`](THIRD_PARTY.md) and [`THIRD_PARTY-research.md`](THIRD_PARTY-research.md).

## Licence

[Apache License 2.0](LICENSE).
