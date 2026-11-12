# Architecture

Stable things only. Paths are real; for line-level detail read the code and its comments.

## Bird's-eye view

A founder chats with an assistant inside a **project**. After every turn, the app extracts **facts** from the
conversation and asks an LLM **judge** whether the current **phase**'s exit criteria are met. The **gate** turns the
judge's per-criterion answers into PASS / WARN / BLOCK with code, not with the model's discretion. Research tools
gather public **demand signals** through a Python sidecar. When the phases are done (or partly done), the project is
exported as a folder of documents a coding agent can start from (PRD, planning, persona, `CLAUDE.md`).

## Modules

| Module | Responsibility | Entry |
|---|---|---|
| Chat runtime | streams a turn, runs tools, then schedules the post-turn passes in `after()` | `apps/chat/app/(chat)/api/chat/route.ts`, `lib/ai/core-chat-agent.ts` |
| Phase engine | phase definitions, fact extraction, the judge and the gate decision | `lib/phases/{definitions,extract,gate,runtime}.ts` |
| Unblocking tasks | turns a BLOCK verdict into founder tasks with stable ids, and lays them out as a canvas | `lib/ultraplan/{blockers,tasks,graph}.ts`, `components/canvas/` |
| Personas | an evidence-backed customer persona built from stored facts, plus the founder-filled seats a simulation needs | `lib/personas/` |
| Signals | asks the sidecar, lane by lane, for demand signals; permission gate per source | `lib/signals/{provider,providers,sidecar,audience}.ts` |
| Deep research | multi-step web research tool (from ChatJS) that also searches through the sidecar | `tools/platform/deep-research/` |
| Simulation | persona reactions to a pitch (OASIS, in the sidecar); a hypothesis generator, never evidence | `lib/research/simulation.ts`, `app/actions/run-simulation.ts` |
| Export | a pure plan of every file and byte, returned by a server action and downloaded file by file | `lib/export/handoff.ts`, `app/actions/build-handoff.ts`, `components/export/` |
| Data | Drizzle schema, queries, migrations | `lib/db/schema.ts`, `lib/db/migrations/` |
| API surface | tRPC routers, server actions, route handlers | `trpc/routers/_app.ts`, `app/actions/`, `app/api/` |
| Research sidecar | FastAPI: `/v1/health`, `/v1/signals/{source_id}`, `/v1/simulate`; source adapters and a ranking pipeline | `apps/research/app/{main,config}.py`, `app/sources/`, `app/pipeline/` |
| Shared packages | inherited ChatJS packages: message-thread model, CLI scaffolder, component registry | `packages/{thread,cli,registry}` |

Paths in the table without a prefix are under `apps/chat/`.

## Layer rules

Enforced by: none yet (no boundary tool; see ADR-0001). Customary today:
- Decisions are pure functions and I/O is injected: `decideGate` takes the judge's output, `buildHandoff` takes a
  snapshot and returns every path and byte, `analyzeBlockers`, `reconcileTasks` and `buildCanvasGraph` take data and
  return data.
- Model-facing schemas are lenient and fail closed; stored schemas carry the invariants
  (`lib/phases/types.ts`, `lib/personas/types.ts`).
- The sidecar is the only place that talks to the demand-signal sources. The chat app reaches it over HTTP, at
  `ai.tools.deepResearch.researchSidecarUrl` in `chat.config.ts`, never by importing Python.

## Invariants (stated as absences)

- No path from a judge error to a PASS. No PASS for a phase with no criteria.
- No simulated or machine-written fact counts as evidence; a founder's own fact is never overwritten by extraction.
- No author or username is stored with a demand signal.
- No path enters the export plan unchecked: folder names are slugged to `[a-z0-9-]` and the whole tree is checked
  before the plan is returned.
- No sidecar port is bound beyond `127.0.0.1`.

## Cross-cutting

- **Config:** `apps/chat/chat.config.ts` (models, features, the sidecar URL) validated by `lib/config-schema.ts`;
  env through `lib/env.ts` from `lib/env-schema.ts` and listed in the root `.env.example`; sidecar env in
  `apps/research/app/config.py`.
- **Auth:** better-auth (`lib/auth.ts`). The proxy (`proxy.ts`) guards pages; every API route, tRPC procedure and
  server action checks the session itself.
- **Cost:** `lib/credits/` settles each turn in cents and names any model it could not price.

## Design notes

Decisions that are cheap to undo by accident. The hard-to-reverse ones are ADRs.

**Facts, the gate and the ledger.** Who asserted a fact is stored and carried to the models and the export
(ADR-0003). Every gate verdict is kept in an append-only ledger (ADR-0004). Embeddings live in the one Postgres
(ADR-0002). The schema, its constraints and the migration rules are in `docs/DATABASE.md`.

**Canvas and tasks** (`lib/ultraplan/`, `components/canvas/`).
- The canvas is a pipeline of three pure functions, `analyzeBlockers` then `reconcileTasks` then `buildCanvasGraph`;
  React only draws the graph.
- "The gate has not run" is its own state. `analyzeBlockers` returns `unassessed` with zero blockers, and the phase rail
  (`lib/phases/rail.ts::describeRail`) keeps "not assessed" apart from BLOCK, so a new project does not open on a red
  badge.
- A task id is deterministic (`phaseKey::criterionId::kind`), so re-running the gate reconciles with what the founder
  already ticked. The stored title and detail are a snapshot: a task whose blocker no longer appears in the current
  verdict is flagged `orphaned`, never deleted and never auto-completed.
- Task state has its own table (`ProjectTask`), not a JSON column on the phase row: the post-turn gate pass writes the
  phase row, and ticking a task would race it. `unknown` is what `parseTaskState` returns for a stored string it does
  not recognise; it is never written back.

**Personas and simulation** (`lib/personas/`, `lib/research/simulation.ts`).
- The persona is a `Document` of kind `persona`, versioned per project. Its schema is evidence-only: `evidence[]` is a
  non-empty tuple, so an unevidenced claim is a compile error, and the model-facing draft schema is separate from the
  stored one. With too few facts there is no persona, and a degraded artifact is shown but never stored as a version.
  `assessPersonaReadiness` reports the artifact's structure; it is not a gate.
- OASIS needs an age, gender, MBTI type and country per agent. The persona has none of them on purpose, so the founder
  fills them in as simulation seats (`SimulationProfile`, one row per agent), stored apart from the persona. The
  demographic assumptions are therefore attributable to a person who chose them, not to a model that guessed.
  `toSimulationPersonas` is the one mapper from persona and seats to agents; it reports every gap together, not the
  first.
- A simulation that produced no reactions is a refusal, not a verdict. `judgeSimulation` returns a union whose
  not-assessed arm has no `usable` field, and the stored row keeps `usable` null with a recorded reason, so a run whose
  agents all failed cannot be shown as "the personas all agreed" (Incident 1 in `docs/INCIDENTS.md`).
- Blank seat fields collapse to NULL at three boundaries (the save action, `upsertSimulationProfile`, the mapper),
  because an empty string is not null and slips past `??`.

**Export** (`lib/export/`).
- The export is a documentation repository, not an application: no source code, no `package.json`, no framework and
  no `LICENSE`. The eight phases record no technology choice, and a stack picked by the export would be the most
  consequential decision in the repository, committed under a banner claiming everything is evidence-backed. A licence
  has legal consequences, so it is not guessed on the founder's behalf.
- Zero facts is a refusal, not an empty shell. One fact is enough: a partial export is legitimate, and each document
  says what is missing. A folder name that slugs to nothing (a non-Latin project name) becomes `founder-handoff`.
- Nothing is written on the server. The server action returns the plan, the dialog previews it, and the browser
  downloads one file at a time. `assertWithinRoot` in `paths.ts` is for a server-side writer; none exists, and none
  should be added without a caller.

**Deep research** (`tools/platform/deep-research/`, `lib/research/supervisor.ts`).
- The supervisor runs researchers through a bounded semaphore sized by `maxConcurrentResearchUnits`; the sequential
  queue it replaced took N times as long for the same cost (`NOTICE` records the change to the ChatJS code).
- Every refusal from the sidecar is a named, human-readable reason that reaches the founder verbatim, per source. See
  Incident 7 in `docs/INCIDENTS.md` for what happens when it does not.

## Where to add X

- **A phase criterion:** `lib/phases/definitions*.ts`, its prompt in `prompts/phases/`, then
  `lib/phases/definitions.test.ts` must still pass. Read `.claude/rules/phases-gate.md` first.
- **A table or column:** `lib/db/schema.ts`, then `bun run db:generate`, review, hand-write any CHECK, then update
  `docs/DATABASE.md`.
- **A research source:** a Python adapter in `apps/research/app/sources/` + its descriptor in `registry.py` +
  `config.py::KNOWN_SOURCE_IDS`, then `lib/signals/providers.ts` and `lib/signals/types.ts` on the TypeScript side.
- **A tRPC procedure:** a router under `trpc/routers/`, registered in `trpc/routers/_app.ts`, using
  `protectedProcedure` unless it is deliberately public.
- **An env var:** see `.claude/rules/env-config.md` (the schema, both `.env.example` files, `turbo.json`, the check
  script).
- **A hard-to-reverse choice:** a new ADR in `docs/ADR/`. **An incident:** an entry in `docs/INCIDENTS.md` with its
  guard.

## Where the rest is written down

| For | Read |
|---|---|
| the schema, constraints, migrations, push versus migrate | `docs/DATABASE.md` |
| why a hard-to-reverse choice was made | `docs/ADR/` |
| what broke, how it was found and what guards it | `docs/INCIDENTS.md` |
| the words the code uses (phase, gate, criterion, fact, origin, signal, lane) | `CONTEXT.md` |
| the sources behind the gate and the phase criteria | `apps/chat/lib/phases/REFERENCES.md` |
| the sidecar, its sources and its source policy | `apps/research/README.md` |
| setting up and running locally | `README.md`, `GETTING-STARTED.md`, `README-DEV.md` |
| what was copied from where, under which licence | `NOTICE`, `THIRD_PARTY.md`, `THIRD_PARTY-research.md` |
