# RECONSTRUCTION.md — navigation map for Claude Code sessions
<!-- bearings-sha: c9be663d3ef3f45112fa8ff6ce55cabcc30f7556 -->
<!-- bearings-date: 2026-11-12 -->

Read this before navigating or editing unfamiliar parts of the codebase. It is a map with pointers, not a copy of
CLAUDE.md — rules live there (and in `.claude/rules/`), geography lives here.

## What this app is
Founder Idea Check tests a startup idea before anyone builds it: an eight-phase conversation whose gates refuse to
advance without evidence, a Python research sidecar that collects public demand signals, persona simulation, and an
export that hands the validated project to a coding agent. A Bun/turbo monorepo forked from ChatJS (Apache-2.0):
Next.js 16 + Postgres/pgvector + OpenAI models. It runs locally; nothing is deployed.

## Directory map
| Dir | Purpose | Edit guidance |
|---|---|---|
| `apps/chat/app/` | Next.js routes: `(chat)` pages and `/api/chat`, server actions in `actions/`, `api/` (files, cron, dev-login) | Every route checks the session itself; `proxy.ts` skips `/api` |
| `apps/chat/lib/phases/` | The phase engine: definitions, gate judge, extraction, advance, the per-turn system block | Fail-closed; read `.claude/rules/phases-gate.md` first |
| `apps/chat/lib/signals/`, `apps/chat/tools/platform/deep-research/` | Research: audience reading, source ranking, the sidecar client, the deep-research pipeline | Source ids are mirrored in Python; see `.claude/rules/research-sources.md` |
| `apps/chat/lib/research/`, `apps/chat/lib/personas/` | Persona building and simulation (output is never evidence) | `usableAsEvidence: false` is load-bearing |
| `apps/chat/lib/export/` | The handoff: a pure plan of files the browser downloads | Pure module; see `.claude/rules/export.md` |
| `apps/chat/lib/db/` | Drizzle schema, queries, hand-written migrations | `.claude/rules/db.md`; never `db:migrate` the dev DB |
| `apps/chat/lib/file-*.ts`, `lib/utils/` | Stored files (owner-tagged keys), access rule, safe URL fetch | Access-control code; keep the property in `lib/file-access.ts` |
| `apps/chat/components/` | React UI; `phase/`, `project/`, `simulation/`, `export/` are ours, the rest is ChatJS | `apps/chat/AGENTS.md` for TS/React conventions |
| `apps/chat/trpc/routers/` | tRPC procedures (`phase`, `project`, `chat`, …) | Owner check answers NOT_FOUND for missing and not-yours alike |
| `apps/chat/evals/` | Paid gate-calibration eval (`bun run eval:gate`) | Costs money; ask first |
| `apps/research/app/` | FastAPI sidecar: `main.py` endpoints + caller auth, `sources/`, `pipeline/`, `simulation/` | Python 3.11; ruff + pytest are its only checks |
| `packages/` | Inherited ChatJS packages (`thread`, `cli`, `registry`), private | Leave unless a task is about them |
| `docs/`, `.planning/`, `.claude/` | Human docs and ADRs; state and deep dives; agent rules and hooks | All public: no personal data, paths or secrets |

## Where the core business logic lives
- `apps/chat/app/(chat)/api/chat/route.ts` — one chat turn: validation, system prompt, stream, then post-turn passes in `after()`
- `apps/chat/lib/phases/definitions.ts` — the eight phases and their exit criteria
- `apps/chat/lib/phases/gate.ts` — the gate judge; every error path is a BLOCK
- `apps/chat/lib/phases/runtime.ts` — post-turn phase pass: extraction, gate run, phase advance
- `apps/chat/lib/phases/extract.ts` — fact extraction; never overwrites a founder's fact
- `apps/chat/lib/phases/advance.ts` — what moves a project to the next phase (WARN advances)
- `apps/chat/lib/phases/directive.ts` — the per-turn instructions the assistant gets inside a project
- `apps/chat/lib/db/phase-queries.ts`, `apps/chat/app/actions/correct-fact.ts` — the fact store and founder corrections
- `apps/chat/lib/signals/audience.ts` — who the buyer is, which decides source ranking and communities
- `apps/chat/lib/signals/provider.ts`, `apps/chat/lib/signals/providers.ts` — signal harvest and the source list
- `apps/chat/tools/platform/deep-research/pipeline.ts`, `sidecar-search.ts` — deep research and its search steps
- `apps/chat/lib/research/simulation.ts`, `apps/chat/app/actions/run-simulation.ts` — persona simulation with caps and charges
- `apps/chat/lib/export/planning.ts`, `apps/chat/lib/export/handoff.ts` — the export plan
- `apps/chat/lib/file-access.ts` — who may read a stored file
- `apps/research/app/main.py`, `apps/research/app/sources/registry.py` — sidecar endpoints and its sources

## Read these before editing
- The gate or a phase → `apps/chat/lib/phases/REFERENCES.md`, `.claude/rules/phases-gate.md`
- The schema or a migration → `docs/DATABASE.md`, `.claude/rules/db.md`
- A research source → `apps/research/README.md`, `.claude/rules/research-sources.md`
- Auth, sessions, dev sign-in → `.claude/rules/auth.md`
- Env vars → `.claude/rules/env-config.md`, `.env.example`
- Domain words → `CONTEXT.md`; decisions → `docs/ADR/`; past incidents and their guards → `docs/INCIDENTS.md`

## Deep dives (generated, stamped)
| Question | Read |
|---|---|
| Architecture / data flow | `.planning/codebase/ARCHITECTURE.md` |
| Directory layout | `.planning/codebase/STRUCTURE.md` |
| Conventions | `.planning/codebase/CONVENTIONS.md` |
| Testing | `.planning/codebase/TESTING.md` |
| Stack / deps | `.planning/codebase/STACK.md` |
| Integrations | `.planning/codebase/INTEGRATIONS.md` |
| Known debt / fragile areas | `.planning/codebase/CONCERNS.md` |

Check the `<!-- refreshed: -->` stamp; the SessionStart line says whether they are stale. Refresh: re-map the drifted
dirs only, fix drifted rows here, commit, then `bash .claude/hooks/bearings-stamp.sh` and commit the stamp.

## Landmines you can't grep your way to
1. The public history starts at one root commit holding ChatJS at upstream commit `14113a98`; upstream's own history is
   not in this repo. Take later upstream changes as squashed commits: a real merge would import upstream's history.
2. Public commit times are blurred to 12:xx UTC on the real calendar day; never read anything into a commit's time.
3. The migration journal's `when` values for 0045–0053 were set to noon UTC on their real day; their order is kept.
   A fresh database is unaffected. A database migrated with `db:migrate` past 0045 under the old values could skip or
   re-run some of them; no such database exists outside the original development machine. Upstream's 0033/0034 are out
   of time order in upstream itself. Do not "fix" either.
4. The local dev database was built with `db:push`, so its migration ledger lags the schema. Never `db:migrate` it.
5. Stored file keys before 2026-11-12 carry no owner tag; they are readable only in chats that held them before that
   day (`OWNER_TAG_ROLLOUT` in `apps/chat/lib/file-storage.ts`).
6. The two keyless Reddit scrapers were removed from every public commit; the Arctic Shift archive is the only Reddit
   lane. Do not add a Reddit scraper back (see `apps/research/README.md`).
7. A tool-input stream sometimes freezes and strands a half-written document. It is shown and recoverable, not fixed;
   capture the server log and network at once if you reproduce it.
