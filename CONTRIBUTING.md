# Contributing

Thanks for taking the time. Founder Idea Check helps a founder test an idea before building it,
and it is a fork of [ChatJS](https://github.com/FranciscoMoretti/chat-js) (see `NOTICE`). Bug
reports, fixes and focused improvements are welcome.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first. To report a security problem, follow
[SECURITY.md](SECURITY.md) instead of opening an issue.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach
  before you spend time on it.
- Check `CONTEXT.md` for the words this project uses (phase, gate, criterion, fact, signal) and
  `docs/ARCHITECTURE.md` for where things live.
- Some areas have rules that are easy to break. Read the matching document before changing them:
  the phase gate (`apps/chat/lib/phases/REFERENCES.md`), the database schema and migrations
  (`DATA-LAYER.md`), and the research sources (the "Sources" section of `apps/research/README.md`).

## Set up

Local setup, services and environment variables are in [`README-DEV.md`](README-DEV.md). If you are
starting from a fresh clone, [`GETTING-STARTED.md`](GETTING-STARTED.md) is the copy-paste path.

You need Bun (the version is the `packageManager` field in `package.json`), Docker for Postgres
and Redis, and Python 3.11 for the research sidecar. Install the dependencies with:

```bash
bun install --frozen-lockfile
```

## Check your work

From the repository root:

```bash
bun run verify      # lint + type-check (apps/chat, packages/thread) + ruff for the sidecar
bun run test:unit   # TypeScript unit tests
```

For the sidecar, from `apps/research` (setup is in its README):

```bash
.venv/bin/python -m ruff check app tests
.venv/bin/python -m pytest
```

- The unit tests need no database, no network and no API key.
- `bun run verify` is safe to run beside a dev server. `bun run test:types` is not: it deletes
  `apps/chat/.next/dev/types`.
- Do not run a production build just to type-check.
- The Playwright suite (`bun run test:e2e`) needs the Docker database and is not part of CI. Run it
  locally if you change a user flow.

CI runs the same checks on every pull request. The single required check is `ci-success`.

## Tests

Add a test when you fix a bug or change behaviour, and make it one that would fail without your
change. Do not delete, skip or `.only` an existing test to get a green run; if a test is wrong,
fix it and say why in the pull request.

## Commits and branches

- The commit subject is one sentence that states the problem being fixed, for example
  `A clean clone could not install: bun.lock was stale against package.json`. The body says what
  changed and how you checked it.
- Keep each commit to one concern.
- Branch from `main` and open the pull request against `main`. Any branch name works.

## Pull requests

- Keep the pull request small and focused. A short description of the problem and the fix is
  enough; the template asks for the rest.
- Make sure `bun run verify` and `bun run test:unit` pass, and say how you tested the change.
- Update the documentation that owns the fact you changed (the schema in `DATA-LAYER.md`,
  environment variables in `apps/chat/.env.example` and `README-DEV.md`, a research source in
  `apps/research/README.md`).
- This repository is public. Never put a secret, a personal detail or a local path in a file, a
  commit message or a pull request.

## Licence

This project is licensed under the [Apache License 2.0](LICENSE). Unless you explicitly state
otherwise, any contribution you intentionally submit for inclusion in the project is licensed
under the same terms, without any additional terms or conditions (section 5 of the licence). In
other words: what you contribute goes in under the licence the project already has.

Only submit code you wrote or have the right to submit. If you copy or adapt code from another
project, say where it came from and under which licence in the pull request; it is recorded in
`THIRD_PARTY.md` or `THIRD_PARTY-research.md` and, for a new upstream, in `NOTICE`.
