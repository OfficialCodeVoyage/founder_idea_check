# Architecture

One page, stable things only. Paths are real; for line-level detail read the code and its comments.

## Bird's-eye view

A founder chats with an assistant inside a **project**. After every turn, the app extracts **facts** from the
conversation and asks an LLM **judge** whether the current **phase**'s exit criteria are met. The **gate** turns the
judge's per-criterion answers into PASS / WARN / BLOCK with code, not with the model's discretion. Research tools
gather public **demand signals** through a Python sidecar. When the phases are done, the project is exported as a
folder a coding agent can start from (PRD, planning, persona, `CLAUDE.md`).

## Modules

| Module | Responsibility | Entry |
|---|---|---|
| Chat runtime | streams a turn, runs tools, then schedules the post-turn passes in `after()` | `apps/chat/app/(chat)/api/chat/route.ts`, `lib/ai/core-chat-agent.ts` |
| Phase engine | phase definitions, fact extraction, the judge and the gate decision | `lib/phases/{definitions,extract,gate,runtime}.ts` |
| Unblocking tasks | turns a BLOCK verdict into founder tasks with stable ids | `lib/ultraplan/{blockers,tasks}.ts` |
| Personas | evidence-backed customer personas built from stored facts | `lib/personas/` |
| Signals | asks the sidecar, lane by lane, for demand signals; permission gate per source | `lib/signals/{provider,providers,sidecar,audience}.ts` |
| Deep research | multi-step web research tool (from ChatJS) that also searches through the sidecar | `tools/platform/deep-research/` |
| Simulation | persona reactions to a pitch (OASIS, in the sidecar); a hypothesis generator, never evidence | `lib/research/simulation.ts`, `app/actions/run-simulation.ts` |
| Export | pure plan of every file and byte, then one injected writer | `lib/export/handoff.ts`, `app/actions/build-handoff.ts` |
| Data | Drizzle schema, queries, migrations | `lib/db/schema.ts`, `lib/db/migrations/` |
| API surface | tRPC routers, server actions, route handlers | `trpc/routers/_app.ts`, `app/actions/`, `app/api/` |
| Research sidecar | FastAPI: `/v1/health`, `/v1/signals/{source_id}`, `/v1/simulate`; source adapters and a ranking pipeline | `apps/research/app/{main,config}.py`, `app/sources/`, `app/pipeline/` |
| Shared packages | inherited ChatJS packages: message-thread model, CLI scaffolder, component registry | `packages/{thread,cli,registry}` |

Paths in the table without a prefix are under `apps/chat/`.

## Layer rules

Enforced by: none yet (no boundary tool; see ADR-0001). Customary today:
- Decisions are pure functions and I/O is injected: `decideGate` takes the judge's output, `buildHandoff` takes a
  snapshot and returns every path and byte, and the writer is passed in.
- Model-facing schemas are lenient and fail closed; stored schemas carry the invariants
  (`lib/phases/types.ts`, `lib/personas/types.ts`).
- The sidecar is the only place that talks to external research sources. The chat app reaches it over HTTP
  (`RESEARCH_SIDECAR_URL`), never by importing Python.

## Invariants (stated as absences)

- No path from a judge error to a PASS. No PASS for a phase with no criteria.
- No simulated or machine-written fact counts as evidence; a founder's own fact is never overwritten by extraction.
- No author or username is stored with a demand signal.
- No export path is written without three path checks.
- No sidecar port is bound beyond `127.0.0.1`.

## Cross-cutting

- **Config:** `apps/chat/chat.config.ts` (models, features, research budget) validated by `lib/config-schema.ts`;
  env through `lib/env.ts` from `lib/env-schema.ts`; sidecar env in `apps/research/app/config.py`.
- **Auth:** better-auth (`lib/auth.ts`). The proxy (`proxy.ts`) guards pages; every API route, tRPC procedure and
  server action checks the session itself.
- **Cost:** `lib/credits/` settles each turn in cents and names any model it could not price.

## Where to add X

- **A phase criterion:** `lib/phases/definitions*.ts`, its prompt in `prompts/phases/`, then
  `lib/phases/definitions.test.ts` must still pass. Read `.claude/rules/phases-gate.md` first.
- **A table or column:** `lib/db/schema.ts` → `bun run db:generate` → review, hand-write any CHECK → `DATA-LAYER.md`.
- **A research source:** a Python adapter in `apps/research/app/sources/` + its descriptor in `registry.py` +
  `config.py::KNOWN_SOURCE_IDS`, then `lib/signals/providers.ts` and `lib/signals/types.ts` on the TypeScript side.
- **A tRPC procedure:** a router under `trpc/routers/`, registered in `trpc/routers/_app.ts`, using
  `protectedProcedure` unless it is deliberately public.
- **An env var:** see `.claude/rules/env-config.md` (four places).
