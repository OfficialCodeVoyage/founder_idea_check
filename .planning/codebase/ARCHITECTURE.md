<!-- refreshed: 2026-11-12 -->
last_mapped_commit: 1f00fb4e
# Architecture

**Analysis Date:** 2026-11-12

The human overview is `docs/ARCHITECTURE.md` (modules, layer rules, design notes, where to add X). This file is the
deeper map: the call path of each flow with file paths, the seams where I/O is injected, the entry points, and the
places where code and docs disagree. Where they disagree the code wins; the differences are listed under "Where docs and
code disagree".

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Browser (React 19, Next.js App Router)                                               │
│  chat     components/chat-sync.tsx  (useChat -> POST /api/chat, SSE)                 │
│  rail     components/phase/phase-gate-provider.tsx  (polls phase.getState)           │
│  screens  components/project/*, components/canvas/*, components/export/*             │
└──────────────────────────────────────────────────────────────────────────────────────┘
            │  SSE (UI message stream)   │  tRPC over HTTP (superjson)   │  server actions
            ▼                            ▼                               ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Next.js server (apps/chat)                                                           │
│  route handlers  app/(chat)/api/chat/route.ts, app/api/*                             │
│  tRPC            trpc/routers/_app.ts  (8 routers)                                   │
│  server actions  app/actions/*.ts                                                    │
│  RSC screens     app/(chat)/project/[projectId]/*  (in-process reads)                │
│                                                                                      │
│  Chat runtime       lib/ai/            Phase engine   lib/phases/                    │
│  Deep research      tools/platform/deep-research/   Signals  lib/signals/            │
│  Export             lib/export/        Canvas         lib/ultraplan/                 │
│  Personas           lib/personas/      Simulation     lib/research/                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
            │ models         │ SQL                │ HTTP POST + optional bearer token
            ▼                ▼                    ▼
┌──────────────────────────┐ ┌──────────────────────────┐ ┌───────────────────────────────┐
│ OpenAI via AI SDK        │ │ Postgres 17 + pgvector   │ │ Python sidecar (FastAPI)      │
│ lib/ai/gateways/         │ │ lib/db/ (Drizzle)        │ │ apps/research/app/main.py     │
│ lib/ai/providers.ts      │ │ lib/db/schema.ts         │ │  GET  /v1/health              │
└──────────────────────────┘ └──────────────────────────┘ │  POST /v1/signals/{source_id} │
                                                          │  POST /v1/simulate            │
                                                          └───────────────────────────────┘

Redis or Valkey (optional, REDIS_URL): resumable streams and the anonymous rate limit
(app/(chat)/api/chat/route.ts, lib/utils/rate-limit.ts).
```

Diagram paths are relative to `apps/chat/` unless they start with `apps/`. The component table below gives
full repository paths.

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Chat route | One `POST /api/chat` turn: validate, persist, stream, settle credits, schedule post-turn passes | `apps/chat/app/(chat)/api/chat/route.ts` |
| Core chat agent | Builds the model context (token budget), tool set and `streamText` call | `apps/chat/lib/ai/core-chat-agent.ts` |
| Tool registry | Chooses which tools a turn has: documents, deep research, ChatJS-installed tools, MCP | `apps/chat/tools/platform/tools.ts`, `apps/chat/tools/chatjs/tools.ts` |
| Phase runtime | Reads phase state into the system prompt; after a turn runs extraction then the gate and persists the verdict | `apps/chat/lib/phases/runtime.ts` |
| Gate | Pure `decideGate` over the judge's per-criterion labels, plus the one injected judge seam `evaluateGate` | `apps/chat/lib/phases/gate.ts` |
| Phase sequencing | Pure "which phase is current" and "what does a verdict do to the sequence" | `apps/chat/lib/phases/advance.ts` |
| Phase definitions | The eight `PhaseDefinition`s and their exit criteria | `apps/chat/lib/phases/definitions.ts`, `definitions-discovery.ts`, `definitions-delivery.ts` |
| Fact extraction | Proposes facts from the last exchange; pure `reconcileFacts` decides insert, update or skip | `apps/chat/lib/phases/extract.ts` |
| Fact ranking and budgets | Ranks stored facts into the system prompt; fits transcripts to a token budget | `apps/chat/lib/phases/context.ts` |
| Gate directive and rail | Renders the previous verdict into the next prompt; maps verdicts to rail and card views | `apps/chat/lib/phases/directive.ts`, `apps/chat/lib/phases/rail.ts`, `apps/chat/lib/phases/roster.ts`, `apps/chat/lib/phases/attempt-history.ts` |
| Model adapters | Wrap `generateText` + `Output.object` as the `GateJudge` and `FactExtractor` seams and report usage | `apps/chat/lib/phases/model-adapters.ts` |
| Persona pass | After the phase pass, regenerates the persona when phase 3 earned it | `apps/chat/lib/personas/post-turn.ts`, `apps/chat/lib/personas/trigger.ts`, `apps/chat/lib/personas/runtime.ts` |
| Unblocking tasks and canvas | Pure pipeline `analyzeBlockers` -> `reconcileTasks` -> `buildCanvasGraph`, read in-process by RSC | `apps/chat/lib/ultraplan/*`, `apps/chat/lib/project/canvas-data.ts` |
| Deep research tool | Clarify, brief, supervisor loop, researchers, final report; time-planned against the request budget | `apps/chat/tools/platform/deep-research/deep-research.ts`, `pipeline.ts`, `supervisor-agent.ts`, `researcher-agent.ts`, `research-clock.ts` |
| Signals | Permission gate per source, concurrent fan-out, merge of per-source outcomes, audience ranking | `apps/chat/lib/signals/provider.ts`, `providers.ts`, `audience.ts`, `types.ts` |
| Sidecar client | The one network seam to `apps/research` for signals; speaks and validates the wire format | `apps/chat/lib/signals/sidecar.ts` |
| Simulation | Pure seeding, divergence and verdict logic; socket to the sidecar; action that records the run | `apps/chat/lib/research/simulation.ts`, `apps/chat/lib/research/sidecar-simulation.ts`, `apps/chat/app/actions/run-simulation.ts` |
| Export | Pure `buildHandoff` returns every path and byte; a server action hands the plan to the browser | `apps/chat/lib/export/handoff.ts`, `apps/chat/app/actions/build-handoff.ts` |
| Credits | Per-turn cost accumulator, settlement in cents, balance reads and deductions | `apps/chat/lib/credits/cost-accumulator.ts`, `apps/chat/lib/db/credits.ts` |
| Data layer | Drizzle schema, queries, migrator | `apps/chat/lib/db/schema.ts`, `apps/chat/lib/db/queries.ts`, `apps/chat/lib/db/phase-queries.ts`, `apps/chat/lib/db/migrate.ts` |
| Auth | better-auth session, cookie cache, social providers; page guard in the proxy | `apps/chat/lib/auth.ts`, `apps/chat/proxy.ts` |
| Client chat state | Per-chat runtime store, message tree, persistence and data-stream slices | `apps/chat/lib/stores/`, `apps/chat/lib/runtime-registry/`, `apps/chat/lib/app-chat-runtime.ts` |
| Sidecar app | FastAPI surface, caller auth, gate, ranking pipeline | `apps/research/app/main.py` |
| Sidecar sources | One adapter per source, descriptor-first, raising named errors | `apps/research/app/sources/*.py` |
| Sidecar simulation | Lazy OASIS runner and divergence judge | `apps/research/app/simulation/oasis_runner.py`, `apps/research/app/simulation/personas.py` |
| Message-thread package | Inherited ChatJS thread model | `packages/thread/src/` |

## Pattern Overview

**Overall:** Next.js App Router monolith with a functional core. Decisions live in pure functions that take data and
return data; I/O (model calls, the database, the sidecar socket) is injected through one named seam per module. The
post-turn passes run after the response is flushed, so state computed for turn N reaches the model only through turn
N+1's system prompt.

**Key Characteristics:**
- Pure core, injected seam. `decideGate` (`apps/chat/lib/phases/gate.ts`) is pure; `evaluateGate` takes a `GateJudge`
  closure. The same shape appears as `FactExtractor` (`apps/chat/lib/phases/extract.ts`), `SimulationRunner`
  (`apps/chat/lib/research/simulation.ts`), `HarvestDeps.fetcherFor` (`apps/chat/lib/signals/provider.ts`), `PersonaDeps` and
  `PersonaStore` (`apps/chat/lib/personas/generate.ts`, `apps/chat/lib/personas/store.ts`) and `FanOutDeps` (`apps/chat/lib/research/supervisor.ts`).
  Tests pass closures; the route passes `createModelGateJudge({ model })`.
- Fail closed everywhere a verdict is made: a judge error, a malformed reply, a missing criterion, a sidecar refusal or
  an unparsable stored verdict becomes a BLOCK, a named failure or "not assessed", never a PASS and never an empty list
  that reads as "no evidence".
- Named failures instead of empty results: the sidecar returns `{ok: false, kind, detail}` with HTTP 200
  (`apps/research/app/main.py`), and the app maps it to `SignalFailureKind` (`apps/chat/lib/signals/types.ts`).
- Ownership is checked at every entry point; `proxy.ts` guards pages only, not `/api/*`.
- Two-model split from `apps/chat/chat.config.ts` `ai.workflows`: the strong model for chat and the gate judge, the
  cheaper one for titles and extraction.

## Layers

**Presentation:**
- Purpose: pages, components, client stores, tRPC react client.
- Location: `apps/chat/app/**/page.tsx`, `apps/chat/components/`, `apps/chat/hooks/`, `apps/chat/providers/`,
  `apps/chat/lib/stores/`, `apps/chat/trpc/react.tsx`.
- Contains: server components that load data in-process (`apps/chat/components/project/*-screen.tsx`), client components, the
  chat store (`apps/chat/lib/stores/with-*.ts` over the vendored `apps/chat/lib/stores/base/`).
- Depends on: API surface, pure view helpers (`apps/chat/lib/phases/rail.ts`, `apps/chat/lib/ultraplan/graph.ts`).
- Used by: the browser.

**API surface:**
- Purpose: authenticate, authorise, validate input, call the runtime.
- Location: `apps/chat/app/(chat)/api/`, `apps/chat/app/api/`, `apps/chat/trpc/routers/`, `apps/chat/app/actions/`.
- Contains: route handlers, tRPC routers (`protectedProcedure` in `apps/chat/trpc/init.ts`), `"use server"` actions.
- Depends on: runtime, persistence, `apps/chat/lib/auth.ts`.
- Used by: presentation, Vercel cron.

**Runtime and orchestration:**
- Purpose: sequence model calls and writes.
- Location: `apps/chat/lib/ai/core-chat-agent.ts`, `apps/chat/lib/phases/runtime.ts`,
  `apps/chat/lib/personas/{runtime,post-turn}.ts`, `apps/chat/tools/platform/deep-research/`,
  `apps/chat/app/actions/run-simulation.ts`.
- Depends on: pure decision modules, `apps/chat/lib/db/`, `apps/chat/lib/ai/providers.ts`.
- Used by: API surface.

**Pure decision modules:**
- Purpose: every judgement, unit-testable with no key, network or database.
- Location: `apps/chat/lib/phases/{gate,advance,extract,context,directive,rail,roster,attempt-history,types,definitions*}.ts`,
  `apps/chat/lib/ultraplan/`, `apps/chat/lib/export/`, `apps/chat/lib/signals/{provider,providers,audience,types}.ts`,
  `apps/chat/lib/research/{simulation,supervisor}.ts`,
  `apps/chat/lib/personas/{trigger,normalize,artifact,simulation-input,types}.ts`,
  `apps/chat/tools/platform/deep-research/{research-clock,research-availability,lane-report}.ts`.
- Depends on: types and other pure modules only (`apps/chat/lib/phases/advance.ts` imports `definitions` and `types` only).
- Used by: runtime, API surface, presentation.

**Persistence:**
- Purpose: Drizzle queries and the schema.
- Location: `apps/chat/lib/db/` (`client.ts`, `schema.ts`, `queries.ts`, `phase-queries.ts`, `task-queries.ts`,
  `simulation-queries.ts`, `mcp-queries.ts`, `credits.ts`, `fact-upsert.ts`, `fact-assertion.ts`, `migrations/`).
- Depends on: `apps/chat/lib/env.ts`.
- Used by: runtime, API surface, RSC loaders.

**External:**
- Purpose: model gateways, the Python sidecar, Redis, file storage.
- Location: `apps/chat/lib/ai/gateways/`, `apps/chat/lib/signals/sidecar.ts`, `apps/chat/lib/research/sidecar-simulation.ts`,
  `apps/chat/lib/file-storage.ts`, `apps/research/`.

## Data Flow

### Primary request path: one chat turn

1. The client posts through `DefaultChatTransport` (`apps/chat/components/chat-sync.tsx`): body `{id, message,
   prevMessages, ...}`; `prevMessages` is empty for signed-in users and carries history for anonymous ones. Parallel
   responses first call `POST /api/chat/prepare` (`apps/chat/app/(chat)/api/chat/prepare/route.ts`), then fire one
   `/api/chat` per model (`apps/chat/lib/parallel-chat-requests.ts`).
2. `POST` in `apps/chat/app/(chat)/api/chat/route.ts` runs, in order: `readChatPostBody` (hand-rolled normalisation,
   no zod), `resolveSelectedModelId`, `validateAndSetupSession` (better-auth session, else `handleAnonymousSession`
   rate limit and credit cookie), `prepareChatPersistenceAndCredits` (`handleChatValidation`: chat and message
   ownership, a new chat may only be filed under the requester's own project, title via
   `generateTitleFromUserMessage` in `apps/chat/app/(chat)/actions.ts`, `saveChatIfNotExists`, `saveMessageIfNotExists`, then
   `canSpend`), `prepareChatExecutionInputs` (`calculateMessagesTokens` against `MAX_INPUT_TOKENS`,
   `getThreadUpToMessageId`, MCP connectors when enabled), `consumeAnonymousCreditBeforeStream`.
3. The route arms an abort timer from `CHAT_REQUEST_BUDGET_MS` (`apps/chat/lib/ai/request-budget.ts`, 290 s) and passes
   the same deadline to tools as `requestDeadlineAt`.
4. `executeChatRequest` inserts an empty assistant placeholder with an `activeStreamId`, installs a throttled cancel
   check (`getMessageCanceledAt`, once per second), builds the stream with `createChatStream`, and tees it: one branch
   is drained to its end in the background (`after()` with a promise), so `onFinish` charges the turn whoever reads the
   response, and a client disconnect or a stalled resumable read loop cannot end or skip the charge. The other branch
   is returned as SSE, wrapped by `resumable-stream` when `REDIS_URL` is set (`getStreamContext`; the GET resume
   handler is `apps/chat/app/(chat)/api/chat/[id]/stream/route.ts`), or plain when `resumable-stream` fails before it
   takes the stream. Generation is never tied to the request: a disconnect does not stop the model; the stop button
   does, through `canceledAt`.
5. `createChatStream` composes the system prompt in `getSystemPrompt`: `systemPrompt()` (`apps/chat/lib/ai/prompts.ts`), the
   project's instructions, then `buildPhaseSystemBlock` (`apps/chat/lib/phases/runtime.ts`: persona prompt, current phase prompt
   from `apps/chat/prompts/`, ranked fact block, gate directive). Anonymous chats and chats whose owner does not own
   their project get the plain prompt.
6. `createCoreChatAgent` (`apps/chat/lib/ai/core-chat-agent.ts`) fits history to `CHAT_CONTEXT_BUDGET_TOKENS` (equal to
   `GATE_TRANSCRIPT_BUDGET_TOKENS` in `apps/chat/lib/phases/context.ts`) with `selectContextWindow`, filters reasoning parts,
   converts to model messages, inlines only files the viewer may read (`apps/chat/lib/file-access.ts`), assembles tools
   (`getTools`, `getMcpTools`), applies the anonymous and explicit-tool filters, and calls `streamText` with
   `stopWhen` = 5 steps or a `deepResearch` report result and `maxOutputTokens` clamped to the model ceiling.
7. The result is merged into the UI message stream with metadata; follow-up suggestions stream afterwards when
   `config.ai.tools.followupSuggestions.enabled` (`apps/chat/lib/ai/followup-suggestions.ts`).
8. `onFinish` of `createUIMessageStream` runs once, when the drained branch reaches the end of the stream (after the
   model's finish part has recorded its usage), and runs `finalizeMessageAndCredits`: `rescueDeadToolInputStreams` (salvages a
   frozen `createTextDocument` input as a labelled partial document, `apps/chat/lib/artifacts/text/salvage.ts`), `updateMessage`,
   `CostAccumulator.settle()`, `deductCredits`.
9. Still in `onFinish`, unless the turn was aborted, anonymous, a non-primary parallel reply, projectless, or its chat
   owner is not the project owner, the route registers `after(async () => ...)` that awaits, in sequence,
   `runPostTurnPhasePass` then `runPostTurnPersonaPass`, and charges their cost in `finally` through a second
   `CostAccumulator` (`chargeAccumulatedCost`).

### Phase gate decision (post-turn, inside `after()`)

1. `runPostTurnPhasePass` (`apps/chat/lib/phases/runtime.ts`) resolves the current phase with `resolveCurrentPhase`
   (lowest-order phase not recorded as `passed`). If the database cannot answer it returns `not-assessed`.
2. `runPhasePass` loads the project transcript (`getAllMessagesByProjectId`), the chat transcript
   (`getAllMessagesByChatId` then `selectActiveThread`) and the stored facts; `toTranscript` projects messages to
   turns (a successful document tool call becomes a one-line `documentMarker`); `budgetTranscript` fits the project
   transcript to `GATE_TRANSCRIPT_BUDGET_TOKENS`.
3. Extraction: `extractFacts` runs on `lastExchange(chatTranscript)` through `createModelFactExtractor` (model
   `config.ai.workflows.extract`); `sanitizeFacts` keeps only the phase's `factKeys`; `reconcileFacts` skips a key whose
   stored `origin` is `founder`, an unchanged value, or a lower confidence; `upsertProjectFacts` writes. Failure
   returns zero facts, never throws.
4. `backfillFactEmbeddings` embeds new rows when `getEmbeddingProvider()` is configured; usage goes to the accumulator.
5. The facts are re-read (with `origin`) and `evaluateGate` builds the judge prompt (`buildGatePrompt`: persona prompt,
   phase prompt, criteria, facts, transcript), calls the judge (`createModelGateJudge`, model
   `config.ai.workflows.chat`) and parses with `JudgeOutputSchema`. A throw or a shape mismatch is
   `failClosedVerdict`.
6. `decideGate` applies its rules in fixed order and returns on the first match: empty criteria BLOCK, the single
   `gate.enabled === false` PASS, no evaluations BLOCK, duplicate ids BLOCK, coverage mismatch BLOCK, too few facts
   (`minFactsRequired`, default 1) BLOCK, blocking `not-evaluable` BLOCK, blocking `unmet` BLOCK, blocking `partial`
   above `tolerateBlockingPartials` (default 0) BLOCK, advisory or tolerated partials WARN, otherwise PASS. Every
   non-PASS carries its missing list, next question and a `GateObstacle`.
7. `persistVerdict` calls `planPhaseAdvance` (PASS and WARN mark the phase `passed` and activate the next; BLOCK keeps
   it `active`; a finished workflow absorbs further verdicts) and `recordGateVerdict`
   (`apps/chat/lib/db/phase-queries.ts`): one transaction upserts `ProjectPhase` (attemptCount + 1) and appends a
   `ProjectPhaseAttempt` row.
8. Any exception in step 2 to 7 is caught: the pass logs, `writeFailClosed` persists a fail-closed BLOCK, and the
   outcome is `not-assessed`.
9. `runPostTurnPersonaPass` (`apps/chat/lib/personas/post-turn.ts`) short-circuits unless the outcome is `assessed`, then
   `decidePersonaRegeneration` (`apps/chat/lib/personas/trigger.ts`, phase 3 only) decides whether `regeneratePersona` runs.
10. Landing: the verdict reaches the founder two ways. Next turn, `buildPhaseSystemBlock` reads the phase row and
    renders `buildPhaseDirective` into the system prompt. In the UI, `PhaseGateProvider`
    (`apps/chat/components/phase/phase-gate-provider.tsx`) polls tRPC `phase.getState` until `assessmentCount` changes
    (no push channel exists).

### Deep research: app to sidecar

1. `getTools` registers `deepResearch` when `config.ai.tools.deepResearch.enabled`
   (`apps/chat/tools/platform/tools.ts`). At registration `deepResearch()`
   (`apps/chat/tools/platform/deep-research/deep-research.ts`) runs `decideResearchAvailability` over `ALL_PROVIDERS` and
   `currentDeployment()` (`deployment-mode.ts`). With no search backend (`none`) or every sidecar lane gate-refused
   it registers an "unavailable" description that names the cause; a cloud arm (Tavily, Firecrawl) counts as one lane.
2. `execute` refuses when unavailable (`format: "unavailable"`) or when the conversation is empty
   (`checkResearchRequest`), otherwise calls `runDeepResearchPipeline` with `planResearchClock(requestDeadlineAt ??
   defaultRequestDeadline())`.
3. `runDeepResearchPipeline` (`pipeline.ts`): `readAudience` reads only the founder's turns; `clarifyWithUser`
   (returns `clarifying_question` and ends the tool call); `writeResearchBrief`; `runSupervisor`; `generateFinalReport`,
   which streams a model that must call `createTextDocument`, so the report is a `Document` row.
4. `runSupervisor` (`supervisor-agent.ts`) is a `ToolLoopAgent` with `conductResearch` and `researchComplete`. Topics run
   through `createSemaphore(max_concurrent_research_units)` from `apps/chat/lib/research/supervisor.ts`; a topic that cannot start
   before `searchStopAt` returns "NOT RESEARCHED" and records a cut.
5. `runResearcher` (`researcher-agent.ts`) gets its tools from `getAllTools` (`utils.ts`). `getSearchApi`
   (`configuration.ts`) returns `"sidecar"` first when `researchSidecarUrl` is non-empty, then `tavily`, `firecrawl`,
   else `none`. The sidecar arm is `sidecarWebSearch` (`sidecar-search.ts`), registered under the name `webSearch`.
6. `sidecarWebSearch.execute`: `rankSourcesFor(audience)` and `orderProviders` order the lanes; for each query
   `runSignalHarvest` (`apps/chat/lib/signals/provider.ts`) runs `selectEnabledProviders` (`decideProviderGate`: hosted bar,
   self-host bar, operator toggle, credentials) and fans out `createSidecarSignalFetcher` (`apps/chat/lib/signals/sidecar.ts`),
   one `POST {researchSidecarUrl}/v1/signals/{id}` per permitted source with a 45 s ceiling and a per-step cap from
   `searchStepTimeoutMs`.
7. In the sidecar `fetch_signals` (`apps/research/app/main.py`): `require_caller` (bearer token, or loopback only),
   `find_descriptor`, `resolve_permitted_source` (`assert_permitted` in `apps/research/app/sources/base.py`), `source.fetch`, then
   `_pipeline` (freshness and engagement scores, `dedupe_items`, `weighted_rrf`, `score_candidates`,
   `ground_candidates`), then `to_demand_signal` (no author). Success is `{ok: true, source_id, signals}`; any named
   `SourceError` is `{ok: false, source_id, kind, detail}`, both HTTP 200.
8. Back in the app `parseSignalResponse` validates the body (a `source_id` mismatch or unknown shape is
   `schema-drift`), `harvestSignals` drops uncitable signals, dedupes by URL and sets `inconclusive`, `rankSignals`
   reweights, and `toSearchResults` dedupes again. Lane results stream as `data-researchUpdate` parts (`type: "lanes"`,
   `apps/chat/tools/platform/research-updates-schema.ts`) and the tool returns `{searches, sourceRanking}`, or
   `{searches: [], error}` when nothing usable came back.
9. Deadlines (`research-clock.ts::planResearchClock`), each stepped back from the previous: `reportDueAt` =
   `requestDeadlineAt` - `WRAP_UP_ALLOWANCE_MS`; `findingsDueAt` = `reportDueAt` - `REPORT_ALLOWANCE_MS`;
   `compressionDueAt` = `findingsDueAt` - `HANDOFF_GRACE_MS`; `searchStopAt` = `compressionDueAt` -
   `COMPRESSION_ALLOWANCE_MS`. Cuts are recorded in `clock.cuts` and the report prompt says the search was cut short.
10. Signals are never stored in a table. They exist as streamed update parts and as text inside the report document.

### Simulation

1. The simulation screen calls `runProjectSimulation` (`apps/chat/app/actions/run-simulation.ts`): session, project
   ownership, pitch bounds, persona versions and founder-filled seats, `toSimulationPersonas`
   (`apps/chat/lib/personas/simulation-input.ts`), the seat cap, then `reserveCredits` (`apps/chat/lib/db/credits.ts`), which
   deducts the estimate (`estimateSimulationCostCents`) atomically while the balance is positive, or refuses with
   `insufficient-credits`.
2. `runSimulation` (`apps/chat/lib/research/simulation.ts`) validates seats and calls the injected runner
   `createSidecarSimulationRunner` (`apps/chat/lib/research/sidecar-simulation.ts`): `POST /v1/simulate`, 300 s ceiling.
3. The sidecar imports OASIS lazily inside `run_simulation` (`apps/research/app/simulation/oasis_runner.py`); absence is
   the named failure `oasis-not-installed`. Fewer than two reactions is a named failure, not a verdict.
4. The app judges with `judgeSimulation` (not-assessed arm has no `usable` field). `addCredits` refunds the reserve when
   `simulationReachedModel` is false: a kind in `SIMULATION_NEVER_STARTED_KINDS`, or a `no-reactions` run in which every
   expected agent call failed. `insertSimulationRun` then records a run that happened (`usable` null when nothing was
   measured), whatever was refunded, and `revalidatePath` refreshes the screen. Output is hard-wired
   `usableAsEvidence: false`.

### Canvas and export reads (no model call)

- Canvas: `ProjectCanvasScreen` (`apps/chat/components/project/project-canvas-screen.tsx`) is a server component
  inside `Suspense`; it calls `loadProjectCanvas` (`apps/chat/lib/project/canvas-data.ts`), which runs
  `analyzeBlockers`, `reconcileTasks`, `buildCanvasGraph` in process. A missing project and a foreign project are the
  same `notFound()`.
- Export: `buildProjectHandoff` (`apps/chat/app/actions/build-handoff.ts`) checks the session and ownership, reads
  facts, phases and persona documents, and returns the plan from pure `buildHandoff` (`apps/chat/lib/export/handoff.ts`):
  `refused` for zero facts, else every file with paths slug-checked by `assertSafeTree` (`apps/chat/lib/export/paths.ts`). The
  dialog (`apps/chat/components/export/handoff-export-dialog.tsx`) downloads file by file; nothing is written on the server.

**State Management:**
- Server: Postgres is the single source of truth. Per-project state: `ProjectPhase` (current), `ProjectPhaseAttempt`
  (append-only ledger), `ProjectFact` (unique on `(projectId, key)`), `ProjectTask`, `SimulationProfile`,
  `SimulationRun` (`apps/chat/lib/db/schema.ts`). Personas are `Document` rows of kind `persona`
  (`apps/chat/lib/personas/artifact.ts`).
- Client: a per-chat store built from vendored `ai-sdk-tools` store slices (`apps/chat/lib/stores/with-threads.ts`,
  `with-chat-persistence.ts`, `with-data-stream.ts`, `with-message-parts.ts`), held in a runtime registry
  (`apps/chat/lib/runtime-registry/`), with server state through TanStack Query via tRPC.
- Resumable streams and the anonymous rate limit use Redis when `REDIS_URL` is set; both degrade to off without it.

## Key Abstractions

**PhaseDefinition and ExitCriterion:**
- Purpose: one of `PHASE_COUNT` (8) ordered phases with `factKeys`, `exitCriteria`, `gate` config and a `promptFile`.
- Examples: `apps/chat/lib/phases/types.ts` (schemas), `apps/chat/lib/phases/definitions.ts`,
  `apps/chat/prompts/phases/phase-01-problem.md` through `phase-08-gtm.md`.
- Pattern: Zod-parsed constants; criterion types `artifact-exists`, `requirement-satisfied`, `metric-threshold`;
  severity `blocking` or `advisory`; closure `in-conversation` or `offline-only`. Phase keys:
  `problem-validation`, `solution-shaping`, `user-personas`, `demand-verification`, `positioning`, `mvp-scope`,
  `pricing-economics`, `go-to-market`.

**GateVerdict and GateObstacle:**
- Purpose: the gate's output as data: decision, per-criterion evaluations, missing items, next question, the rule that
  fired.
- Examples: `apps/chat/lib/phases/types.ts` (`GateVerdictSchema`, `GATE_OBSTACLE_KINDS`),
  `apps/chat/lib/phases/gate.ts::failClosedVerdict`.
- Pattern: stored as JSON on both `ProjectPhase.verdict` and `ProjectPhaseAttempt.verdict`; parsed, never cast, on read
  (`apps/chat/lib/phases/directive.ts::toPhaseGateState`).

**Fact with origin:**
- Purpose: a `key = value` with 0-100 confidence and `origin` (`extracted` or `founder`).
- Examples: `apps/chat/lib/db/schema.ts` (`projectFact`), `apps/chat/lib/db/fact-assertion.ts`,
  `apps/chat/app/actions/correct-fact.ts`.
- Pattern: the upsert SQL is dumb (`apps/chat/lib/db/fact-upsert.ts`); all judgement is in `reconcileFacts` and
  `planFactAssertion`.

**CostAccumulator:**
- Purpose: records every LLM and API call of a turn, then settles to cents and names anything it could not price.
- Examples: `apps/chat/lib/credits/cost-accumulator.ts`; passed into `createCoreChatAgent`, `getTools`, the deep
  research pipeline and `chargeUsageTo` (`apps/chat/lib/phases/model-adapters.ts`).
- Pattern: one accumulator for the turn, a second for the post-turn passes, each settled and deducted separately.

**ProviderDescriptor / DemandSignal / SignalFailure:**
- Purpose: how a source may run and what it returns; shared vocabulary of the signals subsystem.
- Examples: `apps/chat/lib/signals/types.ts`, `apps/chat/lib/signals/providers.ts` (`HACKERNEWS`, `WEB_KEYLESS`,
  `GITHUB`, `ARCTIC_SHIFT`, `ALL_PROVIDERS`), Python mirror `apps/research/app/sources/base.py::SourceDescriptor`.
- Pattern: descriptor-first (`enabledInHosted` has no default); the gate is mirrored in
  `apps/chat/lib/signals/provider.ts::decideProviderGate` and `apps/research/app/sources/base.py::assert_permitted`.

**ResearchClock:**
- Purpose: a plan of deadlines derived from one request budget so a long research run finishes its report before the
  route aborts.
- Examples: `apps/chat/tools/platform/deep-research/research-clock.ts`, `apps/chat/lib/ai/request-budget.ts`.
- Pattern: mutable `cuts` list; `stopAt` builds an abort signal for a deadline; `reportWordBudget` sizes the report.

**StreamWriter data parts:**
- Purpose: typed side channel on the UI message stream (`data-chatConfirmed`, `data-researchUpdate`,
  `data-appendMessage`, follow-up suggestions).
- Examples: `apps/chat/lib/ai/types.ts`, `apps/chat/tools/platform/research-updates-schema.ts`.

**Tool registry:**
- Purpose: which tools the model sees this turn.
- Examples: `apps/chat/tools/platform/tools.ts` (`getTools`, `getMcpTools`), `apps/chat/tools/chatjs/tools.ts` (managed
  by the ChatJS CLI, currently `getWeather`, `wordCount`), `apps/chat/lib/ai/installed-tools.ts`.
- Pattern: gated by `chat.config.ts` flags. Web search, URL retrieval, code execution, MCP, image and video are
  configured off in this fork; their code remains. Documents and deep research are on.

**Gateway provider:**
- Purpose: one place that maps a model id to a provider client.
- Examples: `apps/chat/lib/ai/providers.ts::getLanguageModel`, `apps/chat/lib/ai/active-gateway.ts`,
  `apps/chat/lib/ai/gateways/registry.ts` (`DEFAULT_GATEWAY = "openai"`), `apps/chat/lib/ai/app-models.ts`.

## Entry Points

**Pages (App Router):**
- `apps/chat/app/(chat)/page.tsx` new chat; `apps/chat/app/(chat)/chat/[id]/page.tsx` a chat;
  `apps/chat/app/(chat)/share/[id]/page.tsx` a shared chat (public).
- Project screens, each rendering a component from `apps/chat/components/project/`:
  `apps/chat/app/(chat)/project/[projectId]/page.tsx` and
  `apps/chat/app/(chat)/project/[projectId]/canvas/page.tsx` (canvas),
  `apps/chat/app/(chat)/project/[projectId]/phases/page.tsx`,
  `apps/chat/app/(chat)/project/[projectId]/facts/page.tsx`,
  `apps/chat/app/(chat)/project/[projectId]/simulation/page.tsx`,
  `apps/chat/app/(chat)/project/[projectId]/chat/[chatId]/page.tsx`.
- Settings: `apps/chat/app/(chat)/settings/page.tsx`, `apps/chat/app/(chat)/settings/models/page.tsx`,
  `apps/chat/app/(chat)/settings/connectors/page.tsx`,
  `apps/chat/app/(chat)/settings/connectors/[connectorId]/page.tsx`.
- Auth and legal: `apps/chat/app/(auth)/login/page.tsx`, `apps/chat/app/(auth)/register/page.tsx`,
  `apps/chat/app/(auth)/device-login/page.tsx`, `apps/chat/app/privacy/page.tsx`, `apps/chat/app/terms/page.tsx`.
- Metadata routes: `apps/chat/app/manifest.ts`, `apps/chat/app/sitemap.ts`, `apps/chat/app/opengraph-image.tsx`,
  `apps/chat/app/apple-icon.tsx`.
- Guard: `apps/chat/proxy.ts` redirects signed-out users from non-public pages to `/login`; its matcher excludes `api`.

**Route handlers:**
- `apps/chat/app/(chat)/api/chat/route.ts` `POST`: the chat turn (also exports `getStreamContext`).
- `apps/chat/app/(chat)/api/chat/prepare/route.ts` `POST`: persist chat and user message before parallel streams;
  authenticated only.
- `apps/chat/app/(chat)/api/chat/[id]/stream/route.ts` `GET`: resume a stream or append a finished message.
- `apps/chat/app/(chat)/api/files/upload/route.ts` `POST` (503 while `config.features.attachments` is false) and
  `apps/chat/app/(chat)/api/files/content/route.ts` `GET` (access decided in `apps/chat/lib/file-access.ts`).
- `apps/chat/app/api/auth/[...all]/route.ts` better-auth handler; `apps/chat/app/api/trpc/[trpc]/route.ts` tRPC handler.
- `apps/chat/app/api/chat-model/route.ts` `POST` sets the `chat-model` cookie;
  `apps/chat/app/api/mcp/oauth/callback/route.ts` `GET` MCP OAuth callback;
  `apps/chat/app/api/dev-login/route.ts` development-only session cookie (404 outside development).
- Cron: `apps/chat/app/api/cron/cleanup/route.ts` `GET` is the only scheduled job (deletes orphaned attachments;
  `isAuthorizedCronRequest` refuses when `CRON_SECRET` is unset). Schedule: daily, declared in `apps/chat/vercel.json`.

**tRPC routers (mounted in `apps/chat/trpc/routers/_app.ts`; procedures use `protectedProcedure` from
`apps/chat/trpc/init.ts` unless deliberately public):**
- `apps/chat/trpc/routers/chat.router.ts`: `getAllChats`, `getChatById`, `getChatMessages`, `renameChat`, `stopStream`,
  `setVisibility`, `setIsPinned`, `deleteChat`, `getPublicChat` (public), `getPublicChatMessages` (public),
  `cloneSharedChat`.
- `apps/chat/trpc/routers/project.router.ts`: `list`, `create`, `getById`, `update`, `setInstructions`, `remove`.
- `apps/chat/trpc/routers/phase.router.ts`: `getState` (polled by the rail), `currentLedger`, `attempts`.
- `apps/chat/trpc/routers/credits.router.ts`: `getAvailableCredits`.
  `apps/chat/trpc/routers/settings.router.ts`: `getModelPreferences`, `setModelEnabled`.
- `apps/chat/trpc/routers/document.router.ts`: `getDocuments`, `getPublicDocuments` (public), `saveDocument`.
  `apps/chat/trpc/routers/vote.router.ts`: `getVotes`, `voteMessage`.
- `apps/chat/trpc/routers/mcp.router.ts`: connector CRUD, `testConnection`, `discover`, `authorize`, `checkAuth`;
  guarded by `config.ai.tools.mcp.enabled`.

**Server actions (`"use server"`):**
- `apps/chat/app/actions/build-handoff.ts`: `buildProjectHandoff`.
- `apps/chat/app/actions/correct-fact.ts`: `correctFact`, `assertFact`, `deleteFact`.
- `apps/chat/app/actions/run-simulation.ts`: `runProjectSimulation`.
- `apps/chat/app/actions/save-simulation-profile.ts`: `saveSimulationProfile`, `deleteSimulationProfileAction`.
- `apps/chat/app/actions/get-chat-models.ts`: `getChatModels` (model list, no session read).
- `apps/chat/app/(chat)/actions.ts` is server-only on purpose and is not a server action (no `"use server"`): it holds
  `generateTitleFromUserMessage`, called by the chat and prepare routes after they resolve a signed-in user.

**Sidecar (`apps/research/app/main.py`):**
- `GET /v1/health` (open; names and gate positions only), `POST /v1/signals/{source_id}` and `POST /v1/simulate`
  (both behind `require_caller`). Started with `uvicorn app.main:app`; container from `apps/research/Dockerfile`.

**Scripts (not request paths):** `apps/chat/scripts/` (`check-env.ts`, `dev-local.sh`, `seed-demo.ts`,
`embed-facts.ts`, `retrieval-check.ts`, `fetch-models.ts`, `worktree-setup.sh`, `db-branch-*.sh`, `with-db.sh`,
`demo-run.ts`); `apps/chat/lib/db/migrate.ts` (run by the `build` script before `next build`); repo-root `scripts/`
(`verify.sh`, `test-integrity.sh`, `sync-template.ts`, `ai-post-codegen.sh`); evals in `apps/chat/evals/`.

## Architectural Constraints

- **Threading:** Node request handlers; no worker threads. The post-turn passes run in Next's `after()` and must be
  awaited inside it, or the platform freezes them (`apps/chat/app/(chat)/api/chat/route.ts`). The sidecar's endpoints are
  synchronous `def` functions that FastAPI runs in a threadpool; its HTTP client is stdlib `urllib`
  (`apps/research/app/http.py`).
- **Request budget:** one turn is bounded by `CHAT_REQUEST_BUDGET_MS` (290 s), the number every research deadline is
  derived from (`apps/chat/lib/ai/request-budget.ts`).
- **Global state:** module-level Redis clients with top-level `await connect()` and `globalStreamContext` in
  `apps/chat/app/(chat)/api/chat/route.ts`; `promptCache` map in `apps/chat/lib/phases/runtime.ts` (failures are not
  cached); `db` singleton in `apps/chat/lib/db/client.ts`; `config` in `apps/chat/lib/config.ts`; `auth` in
  `apps/chat/lib/auth.ts`; MCP client cache in `apps/chat/lib/ai/mcp/mcp-client.ts` and `cache.ts`; sidecar `SETTINGS`
  read once at import in `apps/research/app/main.py`, and the `ARCTIC_SHIFT_LIMITER` rate limiter in
  `apps/research/app/http.py`.
- **Prompts from disk:** `apps/chat/lib/phases/runtime.ts::loadPrompt` reads `apps/chat/prompts/**` with `readFileSync` at request
  time, so `apps/chat/next.config.ts` traces `./prompts/**/*`. A prompt placed elsewhere is missing in a deployed build,
  and `loadPrompt` returns an empty string instead of throwing.
- **Prerendering:** `cacheComponents` and `partialPrefetching` are on (`apps/chat/next.config.ts`). Screens that depend
  on the session sit under `Suspense` with `params` passed as a promise; never wrap a session-reading component in
  `"use cache"`.
- **Anonymous users have no project, no phases and no facts:** the post-turn passes return early for them.
- **Circular imports:** none known. `apps/chat/lib/phases/runtime.ts` does not import `apps/chat/lib/personas`, on purpose, so the route
  sequences the two passes (`apps/chat/lib/personas/post-turn.ts` imports the `PhasePassOutcome` type from it).
- **Single database:** embeddings live in Postgres with pgvector (`docs/ADR/0002-postgres-pgvector-for-embeddings.md`);
  the dev database is built with `db:push`, never `db:migrate` (`docs/DATABASE.md`).
- **Python 3.11 only** for the sidecar (OASIS pin, `apps/research/pyproject.toml`); the simulation is an optional extra
  imported lazily.

## Anti-Patterns

### Reaching into `app/` from `apps/chat/lib/`

**What happens:** `apps/chat/lib/ai/core-chat-agent.ts` imports three helpers from `apps/chat/app/(chat)/api/chat/`
(`add-explicit-tool-request-to-messages`, `filter-reasoning-parts`, `get-recent-generated-image`); the resume route
imports `getStreamContext` from the sibling chat route; `apps/chat/lib/phases/runtime.ts` and `apps/chat/lib/ai/types.ts` import
from `apps/chat/tools/platform/`.
**Why it's wrong:** there is no boundary tool (`docs/ARCHITECTURE.md`, "Layer rules"), so the direction lib -> app and
lib -> tools is unenforced and makes the "pure" layer depend on route-folder files.
**Do this instead:** put new shared helpers in `apps/chat/lib/` and import them from routes; do not add further
`@/app/...` imports under `apps/chat/lib/`.

### Judging or writing in the stream path

**What happens:** a new pass that needs the model's reply is added inside the stream's `execute`.
**Why it's wrong:** the verdict then competes with the response and cannot be charged separately.
**Do this instead:** add it to the awaited sequence inside `after()` in `route.ts` (phase pass, persona pass) and charge
it through `postTurnCost`; keep the decision pure like `decideGate`.

### Returning `[]` for a failure

**What happens:** an adapter or fetcher that cannot reach a source returns an empty list.
**Why it's wrong:** an empty list reads as "nobody is discussing your idea" and can feed a BLOCK.
**Do this instead:** raise a named `SourceError` (`apps/research/app/errors.py`) and let `SignalFetchOutcome`
(`apps/chat/lib/signals/types.ts`) carry the failure to the report, as `sidecar-search.ts` does.

### A second implementation of an ownership check

**What happens:** an entry point re-derives "is this project the caller's".
**Why it's wrong:** copies drift; `apps/chat/trpc/routers/_app.ts` records a deleted tRPC duplicate of `build-handoff.ts`.
**Do this instead:** follow the shared posture: `getProjectById`, then `project.userId !== session.user.id`, answered
as not-found for both "missing" and "not yours" (`apps/chat/trpc/routers/phase.router.ts`, `apps/chat/app/actions/build-handoff.ts`).

## Error Handling

**Strategy:** fail closed, name the cause, never break the stream.

**Patterns:**
- Post-turn passes never throw: `runPostTurnPhasePass` catches and writes a fail-closed BLOCK; `chargeAccumulatedCost`
  catches its own errors; `extractFacts` returns `[]` on any failure and reports through `onError`.
- Route errors map to `ChatSDKError` responses (`apps/chat/lib/ai/errors.ts`); stream errors map through
  `getStreamErrorMessage` (`apps/chat/lib/ai/stream-errors.ts`) and clear `activeStreamId` so a client does not resume a dead stream.
- Tool failures return structured results (`format: "unavailable"`, `"problem"`, `{status: "error"}`) rather than
  stack traces (`deep-research.ts`).
- Sidecar refusal statuses are classified in `apps/chat/lib/signals/sidecar.ts::classifySidecarStatus` (401 and 403 mean
  `missing-credential`, 429 `rate-limited`, 400 and 422 `schema-drift`, else `unavailable`).
- A dead tool-input stream is salvaged, marked `output-error` and announced in the message
  (`apps/chat/lib/artifacts/text/salvage.ts`, `rescueDeadToolInputStreams` in `route.ts`).

## Cross-Cutting Concerns

**Logging:** pino through `createModuleLogger("scope")` (`apps/chat/lib/logger.ts`); the sidecar uses `logging`
(`research.sidecar`). Telemetry is a no-op (`apps/chat/instrumentation.ts`); AI SDK telemetry flags are set per call.
**Validation:** Zod for tRPC inputs, model-facing output schemas (lenient, `apps/chat/lib/phases/types.ts`) and stored schemas
(strict, `apps/chat/lib/personas/types.ts`); the chat route normalises its body by hand (`readChatPostBody`); the sidecar uses
pydantic request models (`SignalRequest`, `SimulationRequest`).
**Authentication:** better-auth (`apps/chat/lib/auth.ts`) with cookie cache; every handler, procedure and action reads
the session itself. The sidecar authenticates callers with `RESEARCH_SIDECAR_TOKEN` or loopback only
(`apps/research/app/main.py::require_caller`, `docs/ADR/0005-sidecar-caller-auth.md`).
**Configuration:** `apps/chat/chat.config.ts` validated by `apps/chat/lib/config-schema.ts`, read through `apps/chat/lib/config.ts`; env
through `apps/chat/lib/env.ts` from `apps/chat/lib/env-schema.ts`; sidecar env in `apps/research/app/config.py`.
**Cost:** `CostAccumulator` per turn and per post-turn pass, `canSpend` before a turn; a simulation reserves its estimate
before the run and is refunded only when `simulationReachedModel` is false (reserve, run, refund).

## Where docs and code disagree

- **Hosted mode.** `CONTEXT.md` ties "hosted mode" to `RESEARCH_HOSTED`. In the app, `currentDeployment()`
  (`apps/chat/tools/platform/deep-research/deployment-mode.ts`) reads `config.ai.tools.deepResearch.hosted`
  (`apps/chat/chat.config.ts`, currently `false`); `RESEARCH_HOSTED` is declared in `apps/chat/lib/env-schema.ts` but
  nothing under `apps/chat/lib/` or `apps/chat/tools/` reads it. Only the sidecar reads it
  (`apps/research/app/config.py`, default hosted), and `docker-compose.yml` sets it to `"false"` for the container. The
  two halves of the mirrored gate can therefore hold different modes. Every source sets `enabled_in_hosted=True` today
  (`apps/research/app/sources/`), so the difference has no effect until a source is barred in hosted mode.
- **Proxy public pages.** `apps/chat/proxy.ts` names `/models` and `/compare` as public pages; no such routes exist
  under `apps/chat/app/`. Its `isPublicApiRoute` branch is also unreachable while the matcher excludes `api`.

---

*Architecture analysis: 2026-11-12*
