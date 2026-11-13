<!-- refreshed: 2026-11-12 -->
last_mapped_commit: c9be663d
# Codebase Structure

**Analysis Date:** 2026-11-12

The call paths behind these folders are in `.planning/codebase/ARCHITECTURE.md`; the human overview and its "Where to
add X" list are in `docs/ARCHITECTURE.md`.

## Directory Layout

```
founder-idea-check/                     # Bun workspaces + turbo monorepo (`package.json`, `turbo.json`)
├── apps/
│   ├── chat/                           # Next.js 16 app (`@chatjs/chat`): UI, API, phase engine, data layer
│   │   ├── app/                        # App Router: pages, route handlers, server actions
│   │   │   ├── (chat)/                 # Signed-in shell: chat, project screens, settings, share, chat APIs
│   │   │   ├── (auth)/                 # login, register, device-login
│   │   │   ├── actions/                # "use server" actions
│   │   │   ├── api/                    # auth, trpc, cron, dev-login, chat-model, mcp oauth callback
│   │   │   └── privacy/, terms/        # legal pages
│   │   ├── components/                 # React components (flat files + domain folders)
│   │   │   ├── ui/                     # shadcn primitives (Biome-ignored)
│   │   │   ├── ai-elements/            # vendored AI chat building blocks (Biome-ignored)
│   │   │   ├── part/                   # renderers for message parts and tool parts
│   │   │   ├── project/                # project screens (canvas, facts, phases, simulation)
│   │   │   ├── canvas/, phase/, persona/, simulation/, export/, chat/, settings/, upgrade-cta/
│   │   │   └── *.tsx                   # sidebar, chat system, research progress, artifacts, ...
│   │   ├── hooks/                      # client hooks (`use-*.ts`, `chat-sync-hooks.ts`)
│   │   ├── providers/                  # React context providers (session, models, chat input)
│   │   ├── lib/                        # all non-UI logic (see "lib/" below)
│   │   ├── tools/                      # model tools: `platform/` (this product), `chatjs/` (CLI-managed)
│   │   ├── trpc/                       # tRPC init, server/react clients, `routers/`
│   │   ├── prompts/                    # markdown prompts read from disk at request time
│   │   ├── scripts/                    # env check, dev launcher, seeds, embedding backfill, db branch helpers
│   │   ├── evals/                      # evalite evals (gate calibration) and fixtures
│   │   ├── tests/                      # Playwright e2e (`*.e2e.ts`)
│   │   ├── chat.config.ts              # product configuration (models, features, sidecar URL)
│   │   ├── proxy.ts                    # page guard (Next proxy); excludes `api`
│   │   ├── next.config.ts, drizzle.config.ts, vitest.config.ts, playwright.config.ts, biome.jsonc
│   │   └── vercel.json                 # build command and the one cron
│   └── research/                       # Python 3.11 FastAPI sidecar
│       ├── app/
│       │   ├── main.py                 # endpoints, caller auth, per-source pipeline call
│       │   ├── config.py               # env -> `Settings` (fail-closed defaults)
│       │   ├── errors.py, http.py, schema.py
│       │   ├── sources/                # one adapter per source + `registry.py`, `base.py`, `reddit_gate.py`
│       │   ├── pipeline/               # dedupe, fusion, rerank, grounding, cluster, entity_extract
│       │   ├── simulation/             # OASIS runner, persona validation, divergence judge
│       │   └── text/                   # vendored relevance and CJK helpers
│       ├── tests/                      # pytest (`test_*.py`)
│       ├── Dockerfile, pyproject.toml, README.md
├── packages/                           # inherited ChatJS packages
│   ├── thread/                         # `@chatjs/thread`: message-tree thread model
│   ├── cli/                            # `@chat-js/cli`: scaffolder
│   └── registry/                       # `@chat-js/registry`: component/tool registry items
├── docs/                               # `ARCHITECTURE.md`, `DATABASE.md`, `INCIDENTS.md`, `ADR/`
├── docker/searxng/                     # optional SearXNG settings (AGPL, off by default)
├── scripts/                            # repo-level: `verify.sh`, `test-integrity.sh`, `sync-template.ts`
├── LICENSES/                           # licence texts for adapted third-party code
├── .agents/skills/                     # on-demand agent skills (SKILL.md each)
├── .claude/                            # `rules/` (path-scoped), `hooks/`, `settings.json`, `skills/`
├── .github/                            # `workflows/ci.yml`, `rulesets/main.json`, templates, dependabot
├── .planning/                          # `STATE.md`, `DEFERRED-BY-BLOCKER.md`, `agent-setup.md`, `codebase/`
├── docker-compose.yml                  # postgres (pgvector), redis (valkey), research sidecar; loopback ports
├── docker-compose.searxng.yml          # optional SearXNG overlay
├── .env.example                        # the one list of variable names (repo root)
└── CLAUDE.md, AGENTS.md, CONTEXT.md, README*.md, GETTING-STARTED.md, NOTICE, THIRD_PARTY*.md
```

### `apps/chat/lib/` (non-UI logic, by domain)

```
lib/
├── ai/                  # model gateways, chat agent, prompts, budgets, MCP, follow-ups
│   ├── gateways/        # openai, anthropic, vercel, openrouter, litellm, openai-compatible + registry
│   └── mcp/             # MCP client, OAuth provider, cache
├── phases/              # the phase engine (definitions, gate, extraction, runtime, rail, directive)
├── db/                  # schema, queries, migrations, credits, fact upsert/assertion
│   └── migrations/      # drizzle SQL + `meta/` snapshots and `_journal.json`
├── personas/            # evidence-backed persona: types, normalise, generate, store, trigger, post-turn
├── ultraplan/           # blockers -> tasks -> canvas graph (pure)
├── signals/             # demand-signal providers, gate, audience ranking, sidecar client
├── research/            # simulation logic, supervisor semaphore, sidecar simulation socket
├── export/              # handoff plan: documents, grounding, paths, scaffold
├── credits/             # cost accumulator, balance formatting
├── embeddings/          # embedding provider and text helpers
├── stores/              # client chat store slices (`with-*.ts`, `hooks-*.ts`); `base/` is vendored
├── runtime-registry/    # per-chat runtime registry (package-like boundary)
├── artifacts/           # artifact kinds and clients (text, code, sheet), salvage of dead tool input
├── project/             # `canvas-data.ts` (RSC read behind the canvas)
├── utils/, types/, nuqs/, limits/, files/, editor/
└── *.ts                 # config, env, auth, logger, storage, anonymous session, thread utils, ...
```

## Directory Purposes

**`apps/chat/app/(chat)/`:**
- Purpose: the signed-in application shell and everything under it.
- Contains: `apps/chat/app/(chat)/layout.tsx` (providers, sidebar), `apps/chat/app/(chat)/page.tsx`,
  `apps/chat/app/(chat)/chat/[id]/`, `apps/chat/app/(chat)/project/[projectId]/` (canvas, phases, facts, simulation,
  `chat/[chatId]/` beneath it), `apps/chat/app/(chat)/settings/`, `apps/chat/app/(chat)/share/[id]/`,
  `apps/chat/app/(chat)/api/chat/`, `apps/chat/app/(chat)/api/files/`, and `apps/chat/app/(chat)/chat-route-host.tsx`.
- Key files: `apps/chat/app/(chat)/api/chat/route.ts`, `apps/chat/app/(chat)/layout.tsx`,
  `apps/chat/app/(chat)/chat-route-host.tsx`.

**`apps/chat/app/actions/`:**
- Purpose: `"use server"` actions called by client components.
- Contains: `build-handoff.ts`, `correct-fact.ts`, `run-simulation.ts`, `save-simulation-profile.ts`,
  `get-chat-models.ts`. Each (except the model list) reads the session and checks project ownership itself.

**`apps/chat/components/project/`:**
- Purpose: server-component screens for a project, one per route, plus fact and attempt-history rows.
- Key files: `apps/chat/components/project/project-canvas-screen.tsx`, `project-phases-screen.tsx`,
  `project-facts-screen.tsx`, `project-simulation-screen.tsx`.

**`apps/chat/components/part/`:**
- Purpose: renderers for message parts (text, reasoning) and tool parts (documents, deep research, code execution).
- Key files: `apps/chat/components/part/tool-part.tsx`, `apps/chat/components/part/deep-research.tsx`.

**`apps/chat/lib/phases/`:**
- Purpose: the phase engine. Pure modules (`gate.ts`, `advance.ts`, `extract.ts`, `context.ts`, `directive.ts`,
  `rail.ts`, `roster.ts`, `attempt-history.ts`, `types.ts`, `definitions*.ts`) plus the one impure orchestrator
  `runtime.ts` and the model adapters `model-adapters.ts`.
- Key files: `apps/chat/lib/phases/gate.ts`, `apps/chat/lib/phases/runtime.ts`,
  `apps/chat/lib/phases/definitions.ts`, `apps/chat/lib/phases/REFERENCES.md` (sources behind the gate).

**`apps/chat/lib/db/`:**
- Purpose: persistence. `schema.ts` holds every table; queries are split by domain (`queries.ts`,
  `phase-queries.ts`, `task-queries.ts`, `simulation-queries.ts`, `mcp-queries.ts`, `credits.ts`).
- Key files: `apps/chat/lib/db/schema.ts`, `apps/chat/lib/db/client.ts`, `apps/chat/lib/db/migrate.ts`.

**`apps/chat/lib/signals/`:**
- Purpose: the demand-signal vocabulary and gate on the TypeScript side; mirrors `apps/research/app/sources/`.
- Key files: `apps/chat/lib/signals/types.ts`, `providers.ts`, `provider.ts`, `sidecar.ts`, `audience.ts`.

**`apps/chat/tools/platform/`:**
- Purpose: tools this product ships: documents, deep research, web search arms, code execution, image/video (config-off).
- Key files: `apps/chat/tools/platform/tools.ts` (registry), `apps/chat/tools/platform/deep-research/` (pipeline,
  supervisor, researcher, clock, sidecar search), `apps/chat/tools/platform/documents/`.

**`apps/chat/tools/chatjs/`:**
- Purpose: tools installed by the ChatJS CLI; `tools.ts` is CLI-managed and carries markers, do not hand-edit.

**`apps/chat/trpc/`:**
- Purpose: tRPC wiring. `init.ts` (context, `publicProcedure`, `protectedProcedure`), `server.tsx` and `react.tsx`
  (RSC and client callers), `query-client.ts`, `apps/chat/trpc/routers/*.router.ts` registered in `apps/chat/trpc/routers/_app.ts`.

**`apps/chat/prompts/`:**
- Purpose: markdown read from disk at request time and traced into the build by `apps/chat/next.config.ts`.
- Contains: `apps/chat/prompts/phases/phase-01-problem.md` through `phase-08-gtm.md`, `apps/chat/prompts/persona/honesty-protocol.md`,
  `apps/chat/prompts/persona/problem-validation-rubric.md`.

**`apps/chat/scripts/`:**
- Purpose: operational scripts: `check-env.ts` (build and dev gate on env), `dev-local.sh` (dev server outside turbo),
  `with-db.sh`, `db-branch-*.sh`, `seed-demo.ts`, `embed-facts.ts`, `retrieval-check.ts`, `fetch-models.ts`,
  `worktree-setup.sh`.

**`apps/research/app/sources/`:**
- Purpose: one module per source (`hackernews.py`, `web_search_keyless.py`, `github.py`, `arctic_shift.py`), the
  descriptor and gate in `base.py`, the id-to-instance map in `registry.py`, the Reddit access policy in
  `reddit_gate.py`.

**`apps/research/app/pipeline/`:**
- Purpose: scoring and merging of source items: `dedupe.py`, `fusion.py` (weighted RRF), `rerank.py`, `grounding.py`,
  `cluster.py`, `entity_extract.py`. `dedupe.py` and `entity_extract.py` are vendored; do not reformat.

**`docs/`:**
- Purpose: stable documentation. `ARCHITECTURE.md`, `DATABASE.md` (schema, constraints, push-versus-migrate),
  `INCIDENTS.md` (each with its guard), `docs/ADR/NNNN-*.md` (accepted ADRs are never edited).

**`.claude/rules/`:**
- Purpose: path-scoped landmine rules that load when a matching file is read or edited: `.claude/rules/auth.md`, `.claude/rules/db.md`,
  `.claude/rules/docs-sync.md`, `.claude/rules/env-config.md`, `.claude/rules/export.md`, `.claude/rules/phases-gate.md`, `.claude/rules/research-sources.md`.

## Key File Locations

**Entry Points:**
- `apps/chat/app/(chat)/api/chat/route.ts`: the chat turn.
- `apps/chat/app/layout.tsx`: root layout. `apps/chat/app/(chat)/layout.tsx`: signed-in shell.
- `apps/chat/trpc/routers/_app.ts`: tRPC root router. `apps/chat/app/api/trpc/[trpc]/route.ts`: its HTTP handler.
- `apps/chat/app/api/auth/[...all]/route.ts`: better-auth. `apps/chat/app/api/cron/cleanup/route.ts`: the only cron.
- `apps/chat/proxy.ts`: page guard. `apps/chat/instrumentation.ts`: no-op telemetry hook.
- `apps/research/app/main.py`: sidecar (`uvicorn app.main:app`).

**Configuration:**
- `apps/chat/chat.config.ts`: models, feature flags, tool config, `researchSidecarUrl`; schema and defaults in
  `apps/chat/lib/config-schema.ts`; read via `apps/chat/lib/config.ts`.
- `apps/chat/lib/env-schema.ts`, `apps/chat/lib/env.ts`: server env validation; names listed in `.env.example`;
  `turbo.json` `globalEnv` must list each variable the app reads; `apps/chat/scripts/check-env.ts`.
- `apps/research/app/config.py`: sidecar env (`RESEARCH_HOSTED`, `RESEARCH_ENABLED_SOURCES`, `RESEARCH_SIDECAR_TOKEN`,
  `RESEARCH_SIDECAR_ALLOW_UNAUTHENTICATED`, `GITHUB_TOKEN`, `RESEARCH_SEARXNG_URL`).
- `apps/chat/next.config.ts`, `apps/chat/tsconfig.json` (alias `@/*` to the app root), `apps/chat/biome.jsonc`,
  `apps/chat/drizzle.config.ts`, `apps/chat/components.json` (shadcn), `apps/research/pyproject.toml`.
- `docker-compose.yml`: dev services on loopback ports; `.github/workflows/ci.yml`: the only workflow.

**Core Logic:**
- Phase engine: `apps/chat/lib/phases/gate.ts`, `runtime.ts`, `advance.ts`, `extract.ts`, `definitions*.ts`.
- Chat runtime: `apps/chat/lib/ai/core-chat-agent.ts`, `apps/chat/lib/ai/providers.ts`.
- Deep research: `apps/chat/tools/platform/deep-research/pipeline.ts`, `supervisor-agent.ts`, `researcher-agent.ts`,
  `sidecar-search.ts`, `research-clock.ts`.
- Signals: `apps/chat/lib/signals/provider.ts` (gate and harvest), `sidecar.ts` (wire), `providers.ts` (descriptors).
- Persona, canvas, export: `apps/chat/lib/personas/`, `apps/chat/lib/ultraplan/`, `apps/chat/lib/export/handoff.ts`.
- Data: `apps/chat/lib/db/schema.ts`, `apps/chat/lib/db/phase-queries.ts`, `apps/chat/lib/db/queries.ts`.
- Sidecar: `apps/research/app/sources/base.py` (gate), `apps/research/app/sources/registry.py`,
  `apps/research/app/pipeline/fusion.py`.

**Testing:**
- Unit tests are co-located: `apps/chat/lib/phases/gate.test.ts` beside `gate.ts`; about 80 `*.test.ts(x)` files across
  the repo. Runner config: `apps/chat/vitest.config.ts` (excludes `**/*.e2e.ts`).
- E2E (Playwright, local only): `apps/chat/tests/*.e2e.ts`, config `apps/chat/playwright.config.ts`.
- Evals (evalite, spend money): `apps/chat/evals/gate-calibration.eval.ts`, fixtures in `apps/chat/evals/fixtures/`.
- Sidecar: `apps/research/tests/test_adapters.py`, `test_api.py`, `test_gate.py`, `test_pipeline.py`,
  `test_simulation.py` (pytest, no network).
- Packages: `packages/thread/test/`, `packages/cli/src/**/*.test.ts` (Bun runner);
  `.agents/skills/worktree-ports/scripts/worktree-runtime.test.ts`; hook tests `.claude/hooks/hooks.test.sh`.
- CI guard against removed or skipped tests: `scripts/test-integrity.sh`.

## Naming Conventions

**Files (TypeScript):**
- kebab-case for every file: `core-chat-agent.ts`, `phase-gate-provider.tsx`, `gate-verdict-card.tsx`.
- Next.js reserved names stay as is: `page.tsx`, `layout.tsx`, `route.ts`, `loading.tsx`, `not-found.tsx`; dynamic
  segments `[projectId]`; route groups `(chat)`, `(auth)`.
- Role suffixes: `*.router.ts` (tRPC), `*.test.ts` / `*.test.tsx` (unit, co-located), `*.e2e.ts` (Playwright),
  `*.eval.ts` (evalite), `*-screen.tsx` (project RSC screens in `apps/chat/components/project/`), `*-queries.ts` (Drizzle query
  modules in `apps/chat/lib/db/`), `*-provider.tsx` (context providers), `use-*.ts(x)` (hooks), `with-*.ts` (store slice
  enhancers in `apps/chat/lib/stores/`) with a `hooks-*.ts` partner, `definitions-<group>.ts` (phase definitions).
- A split module keeps its stem: `apps/chat/lib/phases/definitions.ts` + `definitions-discovery.ts` + `definitions-delivery.ts`;
  `apps/chat/lib/personas/simulation-input.ts` + `simulation-gaps.ts`.
- No barrel files by rule (`apps/chat/AGENTS.md`); import the file directly through `@/...`. The `index.ts` files in
  `apps/chat/lib/runtime-registry/` and `apps/chat/lib/stores/base/` are inherited package-like boundaries.

**Files (other):**
- Python: snake_case modules (`web_search_keyless.py`, `oasis_runner.py`), tests `test_<area>.py`.
- Migrations: `NNNN_<adjective>_<noun>.sql` from drizzle-kit, or `NNNN_<what>.sql` when hand-written
  (`apps/chat/lib/db/migrations/0051_absent_part_checks.sql`); latest is `0054_message_target_criterion.sql`.
- Prompts: `phase-0N-<slug>.md` under `apps/chat/prompts/phases/`.
- Docs: `docs/ADR/NNNN-<slug>.md`; root docs in SCREAMING-CASE (`CLAUDE.md`, `CONTEXT.md`, `README-DEV.md`).

**Directories:**
- kebab-case lowercase: `deep-research/`, `runtime-registry/`, `upgrade-cta/`. Domain folders are singular nouns for a
  concept (`personas/`, `signals/`) or a verb-free area name (`phases/`, `export/`).
- A component folder per domain under `apps/chat/components/` (`canvas/`, `phase/`, `project/`, `persona/`, `simulation/`);
  generic primitives in `apps/chat/components/ui/`; flat files for shared chrome.

**Symbols:**
- Functions camelCase; components, types, Zod schemas PascalCase (`PhaseDefinitionSchema`, `GateVerdictSchema`);
  constants SCREAMING_SNAKE (`PHASE_COUNT`, `CHAT_REQUEST_BUDGET_MS`, `GATE_TRANSCRIPT_BUDGET_TOKENS`).
- DB: table names are PascalCase strings (`"ProjectPhase"`, `"ProjectFact"`) exported as camelCase consts
  (`projectPhase`); the better-auth tables are lowercase (`user`, `session`, `account`, `verification`).
- Fact keys snake_case (`target_user`), criterion ids kebab-case (`people-interviewed`), phase keys kebab-case
  (`problem-validation`), task ids `phaseKey::criterionId::kind`.
- Cite code in comments by symbol (`apps/chat/lib/phases/gate.ts::decideGate`), never by line number.

## Where to Add New Code

**A phase criterion:**
- Definition: `apps/chat/lib/phases/definitions.ts` (phase 1), `definitions-discovery.ts` (2 to 4) or
  `definitions-delivery.ts` (5 to 8); the fact key goes in that phase's `factKeys` (keys are disjoint across phases).
- Prompt: `apps/chat/prompts/phases/phase-0N-*.md`. Pinned by `apps/chat/lib/phases/definitions.test.ts`; update
  `apps/chat/lib/phases/REFERENCES.md` if a borrowed idea changes. Read `.claude/rules/phases-gate.md` first.

**A table or column:**
- `apps/chat/lib/db/schema.ts`, then `bun run db:generate`, review the SQL, hand-write any CHECK constraint, add queries to
  the matching `apps/chat/lib/db/*-queries.ts`, update `docs/DATABASE.md`. Never `db:migrate` against a `db:push` database.

**A tRPC procedure:**
- A router in `apps/chat/trpc/routers/<domain>.router.ts` using `protectedProcedure`, registered in
  `apps/chat/trpc/routers/_app.ts`. Check ownership inside the procedure and answer not-found for "missing" and
  "not yours".

**A server action:**
- `apps/chat/app/actions/<verb-noun>.ts` with `"use server"`, a session read first, then the ownership check. Put the
  decision in a pure module under `apps/chat/lib/<domain>/` and keep the action to supply data and write rows.

**A route handler:**
- `apps/chat/app/api/<name>/route.ts` for global endpoints or `apps/chat/app/(chat)/api/<name>/route.ts` for chat-scoped
  ones. The proxy does not guard `api`, so read the session in the handler.

**A project screen:**
- Route `apps/chat/app/(chat)/project/[projectId]/<screen>/page.tsx` that passes `params` through unawaited to
  `apps/chat/components/project/project-<screen>-screen.tsx` (a server component: static shell, `Suspense`-wrapped
  private body, loader returns `null` for missing-or-foreign projects).

**A pure decision or view model:**
- `apps/chat/lib/<domain>/<name>.ts` with a co-located `<name>.test.ts`; take data in, return data out, inject any I/O as
  a function parameter (the `GateJudge` pattern in `apps/chat/lib/phases/gate.ts`).

**A research source:**
- Python adapter `apps/research/app/sources/<source>.py` (exports `DESCRIPTOR`, raises `SourceError` subclasses), added to
  `ALL_DESCRIPTORS` and `build_source` in `apps/research/app/sources/registry.py` and to `KNOWN_SOURCE_IDS` in
  `apps/research/app/config.py`; then `apps/chat/lib/signals/providers.ts` and the `SignalSourceId` union in
  `apps/chat/lib/signals/types.ts`; tests in `apps/research/tests/`; update `apps/research/README.md` and
  `THIRD_PARTY-research.md`. The four ids must agree; no test compares both languages.

**A model tool:**
- `apps/chat/tools/platform/<tool>.ts`, registered in `getTools` in `apps/chat/tools/platform/tools.ts` behind a
  `chat.config.ts` flag, its type reaching `ToolName` through `apps/chat/lib/ai/types.ts`, its renderer in
  `apps/chat/components/part/`. Tools installed with the ChatJS CLI go in `apps/chat/tools/chatjs/` and are not edited by hand.

**A component:**
- Domain component: `apps/chat/components/<domain>/<name>.tsx`; shared chrome: `apps/chat/components/<name>.tsx`;
  primitives: `apps/chat/components/ui/` (shadcn, `components.json`). Server component unless it needs interactivity.

**An env var:**
- `apps/chat/lib/env-schema.ts`, root `.env.example`, `turbo.json` `globalEnv`, and `apps/chat/scripts/check-env.ts` when a
  feature needs it. Sidecar-only variables go in `apps/research/app/config.py` and the root `.env.example` only.

**A model or gateway:**
- Model ids in `apps/chat/chat.config.ts` (typed per gateway); gateway code in `apps/chat/lib/ai/gateways/`; pricing and
  limits in `apps/chat/lib/ai/model-capabilities.ts` (an unpriced model is logged as an undercount).

**Utilities:**
- Shared helpers: `apps/chat/lib/utils/` (grouped) or a top-level `apps/chat/lib/<name>.ts`; client-only hooks in
  `apps/chat/hooks/`.

**Decisions and incidents:**
- Hard to reverse: a new file in `docs/ADR/`. An incident: an entry in `docs/INCIDENTS.md` with its guard. A domain
  term: `CONTEXT.md`. Keep docs in sync per `.claude/rules/docs-sync.md`.

## Special Directories

**`apps/chat/lib/db/migrations/`:**
- Purpose: drizzle SQL files, `apps/chat/lib/db/migrations/meta/_journal.json` and snapshots.
- Generated: partly (drizzle-kit writes SQL and `apps/chat/lib/db/migrations/meta/`; CHECK constraints and some files are hand-written).
- Committed: Yes. A new migration needs a `when` in the journal strictly newer than every existing entry.

**`apps/chat/prompts/`:**
- Purpose: runtime-read markdown. Generated: No. Committed: Yes. Must stay inside this folder to be traced.

**`apps/chat/lib/stores/base/`:**
- Purpose: vendored `ai-sdk-tools` store source (`README.md` there). Generated: No. Committed: Yes; avoid local edits.

**`apps/chat/components/ui/`, `apps/chat/components/ai-elements/`:**
- Purpose: shadcn and vendored AI element sources, excluded from Biome in `apps/chat/biome.jsonc`.

**`apps/chat/lib/ai/models.generated.ts`:**
- Purpose: model catalog written by `bun run fetch:models` (`apps/chat/scripts/fetch-models.ts`). Generated: Yes.
  Committed: Yes.

**`packages/registry/items/`:**
- Purpose: JSON registry items for the ChatJS CLI; `packages/registry/index.json` is built from them
  (`packages/registry/build.ts`).

**`.next/`, `node_modules/`, `.turbo/`, `apps/research/.venv/`, `apps/chat/tsconfig.tsbuildinfo`:**
- Purpose: build, dependency and tool caches. Generated: Yes. Committed: No (gitignored).

**`.env.local` (repo root):**
- Purpose: the only env file the app, drizzle and evals load. Present locally, gitignored, never opened by tooling.

**`.planning/`:**
- Purpose: project state and these codebase maps. Committed: Yes, and public: no personal data, local paths or secrets.

---

*Structure analysis: 2026-11-12*
