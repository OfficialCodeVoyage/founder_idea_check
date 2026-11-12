@AGENTS.md

## Claude Code

Founder Idea Check helps a founder test an idea before building it: an eight-phase conversation whose gates refuse
to advance without evidence, a research sidecar that collects public demand signals, and an export that hands the
validated project to a coding agent. It is a fork of ChatJS (Apache-2.0, see `NOTICE`). It runs locally today;
`apps/chat/vercel.json` targets Vercel, and nothing is deployed.

<!-- Maintainers: keep this file ≤200 lines. Path-specific facts go in .claude/rules/, geography in docs/. -->

### Orientation — read this first
- **Navigation map:** `RECONSTRUCTION.md` (≤100 lines): directory map, where the core logic lives, landmines.
- **Deep dives:** `.planning/codebase/` (architecture, structure, conventions, testing, stack, integrations, concerns).
- **Trust signal:** the session-start `Orientation:` / `Codebase maps:` lines say whether those are stale. If stale,
  trust the code over the docs.
- **Path-scoped rules** live in `.claude/rules/` and load when a matching file is read or edited. Don't copy them here.
- **Who calls X / where is Y defined:** use the LSP tool first when its plugin is installed; Grep is for strings,
  config keys and docs.
- **What is in flight and what blocks a push:** `.planning/STATE.md`.

### Tech stack
- Bun 1.3 + turbo 2.9.5 monorepo. `apps/chat`: Next.js 16.3, React 19.2, AI SDK 6, Drizzle 0.45 on Postgres 17 with
  pgvector, better-auth 1.6, tRPC 11, Tailwind 4, Biome through ultracite 7.4.3, vitest 4. `apps/research`: Python
  3.11 FastAPI sidecar. `packages/thread`, `packages/cli`, `packages/registry`: inherited ChatJS packages.
- Models come from OpenAI through `apps/chat/chat.config.ts` (`gpt-5.6-terra` for chat and the gate judge,
  `gpt-5.6-luna` for titles, extraction and research).
- Pins with a reason: Python `<3.12` and `mcp<2` (OASIS, `apps/research/pyproject.toml`); `ultracite@7.4.3`
  (an unpinned `bunx ultracite` pulls a newer major); the `@better-auth/core` override in the root `package.json`
  (its recorded reason is out of date; change it only as a dependency task).

### Commands
```bash
docker compose up -d postgres redis   # dev services: ic-pg :5433, ic-redis :6380 (Valkey)
docker compose -f docker-compose.yml -f docker-compose.searxng.yml up -d searxng   # optional, AGPL, off by default: ic-searxng :8888
PORT=3100 bun run dev:local      # app on http://localhost:3100, sign in at /api/dev-login (use localhost, not 127.0.0.1)
bun run verify                   # lint + type-check + ruff. Run before saying work is done. Safe beside a dev server.
bun run test:unit                # TypeScript unit tests (vitest in apps/chat, bun test in packages)
bun run build                    # only right before a push; it runs the DB migrator first
```
- Sidecar (from `apps/research`): `.venv/bin/python -m pytest` for tests (no network, no key);
  `../../node_modules/.bin/dotenv -e ../../.env.local -- .venv/bin/python -m uvicorn app.main:app --port 8099`
  to run it, then check `http://127.0.0.1:8099/v1/health` (a listening port is not proof).
- Not plain `docker compose up -d` here: it also starts a containerised sidecar on :8099, which would take the port
  from the venv sidecar above. (`README.md` uses it on purpose: a new install has no venv.)
- Not `bun run test:types` beside a dev server: it deletes `apps/chat/.next/dev/types`. `verify` does not.
- Not bare `bun test` inside `apps/chat`: that is Bun's runner, not vitest.

### Environments & data
- Local only. The maintainers' dev database is the Docker container `ic-pg` (database `ideacheck`), built with
  `db:push`. Never run `db:migrate` against it (`.claude/rules/db.md`). A fresh install builds its schema with
  `bun run db:migrate` instead (`docs/DATABASE.md`).
- Env lives in the repo-root `.env.local` (gitignored; never open it). Variable names: the root `.env.example`,
  `apps/chat/lib/env-schema.ts`, `apps/research/app/config.py`.
- Paid calls: chat turns, the gate judge, extraction, research runs and `bun run eval:gate` all hit OpenAI.
  Spend shows in `UserCredit.credits` (cents). Ask before any bulk or eval run.

### Env deltas
None: nothing is deployed.

### Invariants (cheap to violate, expensive to discover)
- **The phase gate fails closed.** The only PASS without evidence is an explicit `gate.enabled === false`; a judge
  error or malformed reply is a BLOCK. Guard: `apps/chat/lib/phases/gate.test.ts`.
- **Nothing synthetic counts as evidence.** Simulation output is hard-wired `usableAsEvidence: false`; persona
  attributes cannot be built without a source (type-enforced); extraction never overwrites a founder's fact.
  Guards: `apps/chat/lib/research/simulation.test.ts`, `apps/chat/lib/phases/extract.test.ts`.
- **Migrations that carry CHECK constraints are hand-written, and the dev DB is never migrated with `db:migrate`.**
  Guard: none automatic; see `docs/DATABASE.md` and Incident 9 in `docs/INCIDENTS.md`.

### Branch, push & deploy
- Default branch `main`. The public repo is `github.com/OfficialCodeVoyage/founder_idea_check`. The `upstream` remote
  is ChatJS with push disabled; never push to it.
- Big or multi-file work goes on `feat|fix|chore/<slug>-<YYMMDD>`. Current release work lands on
  `release/public-prep-261112`.
- A push to `main` is blocked while `.planning/STATE.md` → `### Blockers/Concerns` holds an unresolved push blocker
  (hook). Clear it with a `RESOLVED:` line inside the bullet; never delete the entry.
- `/code-review` must cover changed ts/tsx/js/jsx/mjs/cjs/sql/css files before a push (global hook). Real but
  out-of-scope findings go to `.planning/DEFERRED-BY-BLOCKER.md` → Section F as `SWEEP-F<n>`. Python is outside that
  gate: `verify` (ruff) and pytest are its only automatic checks.
- **CI:** `.github/workflows/ci.yml` is the only workflow and the only one with a `push` trigger; `ci-success` is the
  one required check (`.github/rulesets/main.json`, applied on GitHub at go-live). Pin every action to a full commit
  SHA with a version comment; no secrets, `schedule`, `workflow_run` or `release` triggers. Playwright e2e is local only.
  On PRs `scripts/test-integrity.sh` fails a deleted test file, an added `.only`/`.skip`/`pytest.mark.skip`, or a lower
  test-case count; never get a green run that way.
- **This repository is public.** Every file and every commit message is published, `.planning/` included: no personal
  data, local paths, session ids or secrets anywhere.

### Conventions
- In code comments, cite code by symbol (`lib/phases/gate.ts::decideGate`), never by line number; a global commit
  hook blocks citations that the same diff shifts.
- TypeScript and React conventions are in `apps/chat/AGENTS.md`. The Next.js block at its end is written by
  `next dev`; keep it.
- Long "why" comments next to fail-closed code are the house style. Keep them accurate; don't strip them.
- Commit subjects state the defect being fixed, as a sentence.

### Documentation
- `README.md` — what the product is, the research limit, the quick start. `GETTING-STARTED.md` — the same commands,
  one step at a time with what you should see. `README-DEV.md` — ports, worktrees, verification, the dev database.
- `docs/ARCHITECTURE.md` — modules, layer rules, design notes, where to add X.
- `docs/DATABASE.md` — schema, constraints, migrations, the push-versus-migrate history.
- `docs/ADR/` — hard-to-reverse decisions. `docs/INCIDENTS.md` — incidents, each with its guard.
- `CONTEXT.md` — domain glossary (phase, gate, criterion, fact, origin, signal, lane…). Use its words.
- `apps/research/README.md` — sidecar setup and source policy.
- `NOTICE`, `THIRD_PARTY.md`, `THIRD_PARTY-research.md` — what was copied or adapted, under which licence.
- `.planning/STATE.md` — current focus and push blockers. `.planning/agent-setup.md` — how this agent setup was built.

**Consult before changing:** the gate → `apps/chat/lib/phases/REFERENCES.md`; the schema → `docs/DATABASE.md`; a
research source → `apps/research/README.md`. **Record decisions:** hard to reverse → new ADR; smaller → the commit
message. **Keep in sync:** `.claude/rules/docs-sync.md`.

### Compaction
When compacting, always keep: the current task and its acceptance checks, the files modified, the commands used to
verify, and every owner decision made in this session.
