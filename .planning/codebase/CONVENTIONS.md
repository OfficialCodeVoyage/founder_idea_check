<!-- refreshed: 2026-11-12 -->
last_mapped_commit: c9be663d

# Coding Conventions

**Analysis Date:** 2026-11-12

Every rule below carries one of three labels. Trust the label before the prose.

- **ENFORCED** — a tool fails or blocks. The config or script that does it is named. "Fails CI" means the
  `typescript` or `python` job of `.github/workflows/ci.yml`, which run `bun run verify` (`scripts/verify.sh`),
  `bun run test:unit`, `ruff check app tests` and `pytest`.
- **TESTED** — a unit test pins the property (a census or a guard). It fails CI through `bun run test:unit` or `pytest`.
- **CUSTOMARY** — house style that appears in the code and in `AGENTS.md`, `CLAUDE.md` or `docs/ARCHITECTURE.md`, but
  nothing fails when it is broken. Follow it; do not assume a tool will catch a slip.

## Enforcement Map

| Rule | Label | What enforces it | Runs where |
|---|---|---|---|
| Biome format, lint and import order for `apps/chat` | ENFORCED | `apps/chat/biome.jsonc` extends `ultracite/core`, `ultracite/react`, `ultracite/next`; script `lint` = `ultracite check` (`apps/chat/package.json`) | `bun run verify`, CI |
| Biome lint for `packages/thread` (format with tabs, `recommended` rules) | ENFORCED | `packages/thread/biome.jsonc`, script `lint` in `packages/thread/package.json` (Biome pinned to 2.4.10) | `bun run verify`, CI |
| `packages/cli`, `packages/registry`, `.agents/skills/**/scripts` are neither linted nor type-checked | NOT ENFORCED | No `lint` or `test:types` script in `packages/cli/package.json` or `packages/registry/package.json`; `scripts/verify.sh` lists its steps | n/a |
| TypeScript `strict` for `apps/chat`, tests and evals included | ENFORCED | `apps/chat/tsconfig.json` (`strict`, `include: **/*.ts`); `verify` runs `next typegen . && tsc --noEmit` | `bun run verify`, CI |
| Kebab-case file names | ENFORCED | `useFilenamingConvention` (`kebab-case`) in `ultracite/core` | `ultracite check` |
| No barrel files | ENFORCED | `noBarrelFile` in `ultracite/core`; the two exceptions are `lib/runtime-registry/index.ts` (a `biome-ignore` with a reason) and the vendored `lib/stores/base/*` (`biome-ignore-all`) | `ultracite check` |
| `import type` / `export type` for type-only symbols | ENFORCED | `useImportType`, `useExportType` | `ultracite check` |
| No `any`, non-null `!`, nested ternary, `enum`, `forEach`, namespace import, `delete`, `var`, `==`, `@ts-ignore`, accumulating spread; braces on every `if` | ENFORCED | the matching rules in `ultracite/core` (`noExplicitAny`, `noNonNullAssertion`, `noNestedTernary`, `noEnum`, `noForEach`, `noNamespaceImport`, `noDelete`, `noVar`, `noDoubleEquals`, `noTsIgnore`, `noAccumulatingSpread`, `useBlockStatements`) | `ultracite check` |
| Regex literals at module scope | ENFORCED | `useTopLevelRegex` (tests hoist them as `RE_*` constants) | `ultracite check` |
| Cognitive complexity at most 20 outside tests | ENFORCED | `noExcessiveCognitiveComplexity` (off for `*.test.*` by the override in `ultracite/core`) | `ultracite check` |
| `async` functions must `await` | ENFORCED | `useAwait` (turned off for `next.config.*`, `page.*`, `layout.*` by `ultracite/next`) | `ultracite check` |
| Tailwind class order inside `className`, `cn`, `clsx`, `cva`, `twMerge` | ENFORCED | `useSortedClasses` in `ultracite/core` | `ultracite check` |
| Accessibility, React hooks, `<img>` bans | ENFORCED | the a11y group in `ultracite/core`; `useExhaustiveDependencies`, `useHookAtTopLevel` in `ultracite/react`; `noImgElement` in `ultracite/next` | `ultracite check` |
| Python lint (`E F I UP B SIM RUF`), Python 3.11 only | ENFORCED | `[tool.ruff.lint]` and `requires-python` in `apps/research/pyproject.toml`; `ruff check app tests` | CI `python` job; `verify` only when `apps/research/.venv` exists |
| Python formatting (`ruff format`) | NOT ENFORCED | `verify` runs `ruff check` only; some files are vendored and must not be reformatted (per-file ignores in `apps/research/pyproject.toml`) | n/a |
| Every server env var is listed in `turbo.json` `globalEnv` | TESTED | `apps/chat/lib/env-schema.test.ts` | CI |
| Phase definitions: 8 phases, disjoint fact keys, naming patterns | TESTED | `apps/chat/lib/phases/definitions.test.ts`, `FACT_KEY_PATTERN` / `CRITERION_ID_PATTERN` in `apps/chat/lib/phases/types.ts` | CI |
| A PR may not delete a test file, add `.only` / `.skip`, or lower the test-case count | ENFORCED | `scripts/test-integrity.sh`, job `integrity` in `.github/workflows/ci.yml` | pull requests only |
| `ci-success` must pass before merging to `main` | ENFORCED once applied | `.github/rulesets/main.json` (a file in the tree; it takes effect when applied on GitHub) | GitHub |
| Pin every GitHub Action to a full commit SHA; no `schedule` / `workflow_run` / `release` triggers | CUSTOMARY | header comment of `.github/workflows/ci.yml`; Dependabot moves the pins (`.github/dependabot.yml`) | review only |
| `git push` to `main` while `.planning/STATE.md` holds an unresolved push blocker | ENFORCED (Claude Code sessions only) | `.claude/hooks/require-pr-on-blocker.sh`, config `.claude/guard-push.json`, wired in `.claude/settings.json` (PreToolUse on Bash); its cases are in `.claude/hooks/hooks.test.sh` (run by hand, not in CI) | a maintainer's Claude Code session |
| `.env` files are never read; `git push` asks first | ENFORCED (Claude Code sessions only) | `permissions.deny` / `permissions.ask` in `.claude/settings.json` | Claude Code |
| Biome format of an edited file | local convenience, not a gate | `.claude/hooks/format-on-edit.sh` (format only, never lint fixes, always exits 0); `.vscode/settings.json` (`formatOnSave`) | editor / Claude Code |
| `bun run verify` after an agent edit | local convenience, not a gate | `.codex/hooks.json` (Stop) and `.cursor/hooks.json` (afterFileEdit) both call `scripts/ai-post-codegen.sh` | Codex, Cursor |
| Cite code by symbol, never by line number, in our own comments | CUSTOMARY | stated in `CLAUDE.md`; a global commit hook outside this repository checks it, so a contributor's commit is not checked | review only |
| Commit subject states the defect as a sentence | CUSTOMARY | `CLAUDE.md`, `CONTRIBUTING.md`; no `commit-msg` hook in the tree | review only |
| Branch names `feat\|fix\|chore/<slug>-<YYMMDD>` | CUSTOMARY | `CLAUDE.md`; `CONTRIBUTING.md` says any branch name works; no hook checks it | n/a |
| Update the owning doc in the same commit | CUSTOMARY | `.claude/rules/docs-sync.md`, checklist in `.github/pull_request_template.md` | review only |
| Prefer `env.VAR` over `process.env.VAR`; no `console.log`; avoid `as unknown as` | CUSTOMARY | `apps/chat/AGENTS.md` only. `noProcessEnv` and `noConsole` are `off` in `ultracite/core`; no rule covers the cast | review only |
| Layer rules: pure decisions, injected I/O | CUSTOMARY | `docs/ARCHITECTURE.md` says "Enforced by: none yet"; `noImportCycles` is `off` | review only |

## Naming Patterns

**Files (TypeScript):**
- kebab-case, enforced: `apps/chat/lib/phases/model-adapters.ts`, `apps/chat/components/export/handoff-export-dialog.tsx`.
- A tRPC router is `<name>.router.ts` in `apps/chat/trpc/routers/` and is registered in `apps/chat/trpc/routers/_app.ts`.
- A server action is a verb phrase in `apps/chat/app/actions/` (`build-handoff.ts`, `correct-fact.ts`) starting with `"use server"`.
- Sibling modules share a prefix: `apps/chat/lib/phases/definitions.ts`, `definitions-discovery.ts`, `definitions-delivery.ts`.
- Tests sit beside the code: `gate.ts` and `gate.test.ts` in `apps/chat/lib/phases/`. Playwright files are `*.e2e.ts` in
  `apps/chat/tests/`. Evals are `*.eval.ts` in `apps/chat/evals/`.

**Functions:**
- camelCase, verb first. Builders `buildHandoff`, `buildGatePrompt`; decisions `decideGate`; converters `toExportFacts`,
  `toSimulationPersonas`; reconcilers `reconcileFacts`, `reconcileTasks`; factories `createModuleLogger`,
  `createModelGateJudge`, `createSemaphore`; guards `assertWithinRoot`, `checkRelativePath`, `assertSafeTree`
  (`apps/chat/lib/export/paths.ts`).
- Fail-closed constructors are named for what they produce: `failClosedVerdict` (`apps/chat/lib/phases/gate.ts`),
  `failClosedPersonaArtifact` (`apps/chat/lib/personas/generate.ts`).

**Constants and schemas:**
- Module constants SCREAMING_SNAKE: `PHASE_COUNT`, `MIN_FACT_CONFIDENCE`, `FACT_KEY_PATTERN` (`apps/chat/lib/phases/types.ts`).
- Closed vocabularies are an `as const` array plus a derived type:
  `export const CRITERION_SEVERITIES = ["blocking", "advisory"] as const;` then
  `export type CriterionSeverity = (typeof CRITERION_SEVERITIES)[number];`.
- Zod schemas are PascalCase with a `Schema` suffix: `JudgeOutputSchema`, `GateVerdictSchema`, `PhaseDefinitionSchema`.

**Types:**
- PascalCase. Object shapes are `type` aliases (`export type GateCriterionMeta = { ... }`). `useConsistentTypeDefinitions`
  is `off` in `apps/chat/biome.jsonc`, so `interface` is allowed; the code uses `type`.
- Define a one-off parameter type inline on the function (`apps/chat/AGENTS.md`):
  `buildProjectHandoff({ projectId }: { projectId: string })` in `apps/chat/app/actions/build-handoff.ts`.

**Domain words (CUSTOMARY, from `CONTEXT.md`):**
- Say gate, verdict, phase, criterion, fact, origin, signal, lane, sidecar. Not "validator", "step", "memory", "workspace".
- Fact keys are snake_case (`FACT_KEY_PATTERN`), criterion ids kebab-case (`CRITERION_ID_PATTERN`), task ids
  `phaseKey::criterionId::kind`. The two patterns are checked at runtime by `PhaseDefinitionSchema` and pinned by
  `apps/chat/lib/phases/definitions.test.ts`.

**Database (`apps/chat/lib/db/schema.ts`):**
- Domain tables are PascalCase in Postgres with a camelCase export: `pgTable("UserCredit", ...)` is `userCredit`,
  `pgTable("Chat", ...)` is `chat`. The better-auth tables are lower-case (`"user"`, `"session"`).
- Database access is split by domain, not kept in one file: `apps/chat/lib/db/queries.ts`, `phase-queries.ts`,
  `task-queries.ts`, `simulation-queries.ts`, `mcp-queries.ts`, `credits.ts`.

**Python (`apps/research`):**
- snake_case modules and functions, PascalCase classes, `Source*` for adapter failures (`apps/research/app/errors.py`).
- Wire `kind` strings are kebab-case: `blocked`, `rate-limited`, `schema-drift`, `oasis-not-installed`.
- Private helpers start with `_` (`_classify`, `_get_with_retry`, `_validate_model_id`); tests import them directly.

## Code Style

**Formatting (`apps/chat`, ENFORCED by `ultracite check`):**
- Biome through `ultracite@7.4.3` (pinned; an unpinned `bunx ultracite` pulls a newer major). Settings come from
  `ultracite/core`: 2-space indent, 80 columns, LF, double quotes, semicolons always, trailing commas `es5` (after the
  last array or object member, never after the last function parameter), arrow parentheses always.
- Excluded from lint and format (`apps/chat/biome.jsonc`): `components/ui`, `components/ai-elements`,
  `components/streamdown`, `components/stick-to-bottom`, `lib/utils.ts`, `hooks/use-mobile.ts`,
  `lib/db/migrations/meta`. Match the surrounding file when editing them.
- `packages/thread` uses Biome's defaults (tabs). `packages/cli` is unchecked and also uses tabs; copy the file you edit.
- To check by hand: `bunx ultracite@7.4.3 check` or `bunx ultracite@7.4.3 fix` from `apps/chat` (`apps/chat/AGENTS.md`).

**Suppressions:**
- A `biome-ignore` comment always states a reason after the colon, and is as narrow as the rule allows:
  `// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the rule here` in
  `apps/chat/lib/export/paths.ts`. A whole-file `biome-ignore-all` is used only on vendored code
  (`apps/chat/lib/stores/base/*.ts`). Keep this habit; nothing checks that the reason is good.
- `@ts-expect-error` is used in tests to prove a type refuses something (`apps/chat/lib/db/fact-assertion.test.ts`,
  `packages/thread/test/use-thread-types.ts`); `@ts-ignore` is banned.

**Python (`apps/research`, ENFORCED by `ruff check`):**
- `line-length = 100`, `target-version = "py311"`, rules `E F I UP B SIM RUF`. `E501` is ignored on purpose: long URLs and
  long explanatory comments are the point. Four vendored files carry per-file ignores
  (`app/text/cjk.py`, `app/text/relevance.py`, `app/pipeline/dedupe.py`, `app/pipeline/entity_extract.py`); never run
  `ruff --fix` or `ruff format` over them.
- Almost every module starts with a docstring and `from __future__ import annotations`.
- Use the venv's tools: `apps/research/.venv/bin/python -m ruff` and `-m pytest`, never the system ones.

## Import Organization

**Order (ENFORCED by `organizeImports` in `ultracite/core`):**
1. Node built-ins and external packages (`node:fs`, `zod`, `ai`, `vitest`), alphabetical.
2. Aliased app imports (`@/lib/...`, `@/components/...`).
3. Relative imports (`./types`, `../ai/app-models`).

Type-only symbols use an inline `type` modifier inside a value import
(`import { type CriterionEvaluation, JudgeOutputSchema } from "./types"`) or a separate `import type`.

**Path aliases:** `@/*` maps to the `apps/chat` root (`apps/chat/tsconfig.json`; vitest resolves it with
`vite-tsconfig-paths` in `apps/chat/vitest.config.ts`). Inside one feature folder, siblings import relatively
(`./gate`); across folders they import through `@/`.

**No barrel files.** Import the file that defines the symbol, with a named export. Default exports exist only where
Next or a tool requires them (`apps/chat/app/layout.tsx`, `apps/chat/chat.config.ts`, `*.config.ts`).

**Server boundary (CUSTOMARY):**
- `import "server-only"` marks modules that touch the database, the models or secrets (`apps/chat/lib/phases/runtime.ts`,
  `apps/chat/lib/db/queries.ts`, `apps/chat/lib/personas/store.ts`).
- The pure modules do not import it, so vitest can load them with no mocks: `apps/chat/lib/phases/gate.ts`,
  `extract.ts`, `apps/chat/lib/export/handoff.ts`. A test for an impure module mocks it with
  `vi.mock("server-only", () => ({}))` (`apps/chat/lib/phases/runtime.test.ts`).

## Error Handling

**Fail closed (CUSTOMARY by design, TESTED for the gate):**
- A model call that throws or returns the wrong shape becomes the restrictive outcome, not an exception and not a pass.
  `evaluateGate` in `apps/chat/lib/phases/gate.ts` wraps `deps.judge(request)` in `try/catch`, runs
  `JudgeOutputSchema.safeParse(raw)`, and returns `failClosedVerdict(...)` on either failure. Guard:
  `apps/chat/lib/phases/gate.test.ts`.
- Extraction never breaks the chat stream: `extractFacts` in `apps/chat/lib/phases/extract.ts` reports through an
  injected `onError` and returns no facts (`apps/chat/lib/phases/extract.test.ts`, "never breaks the stream").
- Defaults resolve to the more restrictive value: `RESEARCH_HOSTED` unset means hosted, `RESEARCH_ENABLED_SOURCES` unset
  means the two keyless sources (`apps/research/app/config.py`).

**Unknown is not zero; absence is a state:**
- Use a discriminated union with a distinct "not assessed" arm instead of a number or boolean that can be mistaken for a
  real value. `judgeSimulation` in `apps/chat/lib/research/simulation.ts`, `SignalFetchOutcome` in
  `apps/chat/lib/signals/types.ts`, `unassessed` in `apps/chat/lib/ultraplan/blockers.ts`. Background:
  Incident 1 in `docs/INCIDENTS.md`.

**Results as data across a boundary:**
- A server action returns a tagged union rather than throwing: `BuildHandoffResult` is
  `{ status: "unauthorized" } | { status: "not-found" } | HandoffOutcome` (`apps/chat/app/actions/build-handoff.ts`).
- Ownership failures answer the same way as a missing row (`not-found` / tRPC `NOT_FOUND`), so a caller cannot learn
  whether an id exists (`apps/chat/trpc/routers/chat.router.ts`, `phase.router.ts`).
- tRPC: use `protectedProcedure` (`apps/chat/trpc/init.ts`) unless the procedure is deliberately public; throw
  `TRPCError` with a code; validate input with Zod.

**Untrusted input is parsed, not cast:**
- Zod `safeParse` at every edge: the sidecar response (`SidecarResponseSchema` in `apps/chat/lib/signals/sidecar.ts`),
  judge output, stored json columns (`GateVerdictSchema.safeParse` on a `verdict` column, per `apps/chat/lib/db/schema.ts`). Model-facing schemas are lenient
  (`.default()`), stored schemas carry the invariants (`apps/chat/lib/phases/types.ts`, `apps/chat/lib/personas/types.ts`).
- Never write `as unknown as` to get past a type error (`apps/chat/AGENTS.md`). A few non-test files still do
  (`git grep "as unknown as" -- apps/chat/lib apps/chat/app apps/chat/tools apps/chat/components`); do not add more.

**Python:**
- An adapter never returns `[]` to mean failure. It raises a named `SourceError` subclass (`SourceBlocked`,
  `SourceRateLimited`, `SourceUnavailable`, `SourceDisabled`, `SourceMissingCredential`, `SourceSchemaDrift`) from
  `apps/research/app/errors.py`, each carrying a wire `kind` and a `detail` an operator can act on. Guard:
  `apps/research/tests/test_adapters.py`.
- `apps/research/app/main.py` catches `SourceError` and returns `{"ok": false, "kind": ..., "detail": ...}` as a 200; a
  non-`SourceError` from an adapter is also turned into a failure that names the exception class.
- HTTP uses stdlib `urllib` only (`apps/research/app/http.py`); statuses map to named errors (`_classify`).

## Logging

**Framework:** pino through `createModuleLogger("<scope>")` in `apps/chat/lib/logger.ts`, JSON in production and
`pino-pretty` in development; sensitive keys are redacted.

**Patterns (CUSTOMARY):**
- Route handlers create one child logger per concern: `const log = createModuleLogger("api:chat:stream")` in
  `apps/chat/app/(chat)/api/chat/route.ts`.
- Pure modules do not log. They take an injected `onError` callback, because importing the logger would pull
  `server-only` into vitest (comment on `PersonaDeps` in `apps/chat/lib/personas/generate.ts`).
- `noConsole` is `off`, and `console.error` is still the habit in `apps/chat/lib/db/*queries.ts`;
  `console.log` survives in `apps/chat/lib/db/backfill-parts.ts` and `apps/chat/app/api/cron/cleanup/route.ts`. New server
  code uses the module logger. Scripts under `apps/chat/scripts/` may print.
- Python uses stdlib `logging` (`logging.getLogger("research.sidecar")` in `apps/research/app/main.py`); there is no
  `print(` in `apps/research/app`.

## Comments

**Why, not what (CUSTOMARY, the house style):**
- A long comment next to fail-closed or invariant code explains the defect it prevents, often in capitals for the lead
  sentence: "THE SEAM.", "PURE.", "IT IS BUILT HERE, NOT TAKEN FROM THE JUDGE". Keep these accurate; do not strip them
  (`CLAUDE.md`).
- Files with a pure half and an impure half use banner dividers: `// (a) THE PURE PART.` and `// (b) THE IMPURE PART.` in
  `apps/chat/lib/phases/gate.ts` and `apps/chat/lib/signals/sidecar.ts`.
- A comment that points at an incident names it: `Incident 3` in `docs/INCIDENTS.md`. A rule bullet in `.claude/rules/`
  cites the same number.

**Citing code:**
- Cite our own code by symbol: `lib/phases/gate.ts::decideGate`. Never by line number; the repository's history shows
  those citations drifting and being fixed in bulk.
- Third-party code is cited with the upstream path and the pinned commit (`oasis/social_agent/agents_generator.py` at
  `40bf1705` in `apps/chat/lib/research/simulation.ts`); a line range is acceptable there because the commit is fixed.
- When code is deleted, search comments and docs for its name. Several fixes in the log were comments describing a deleted
  router, writer or function as live.

**Borrowed code banners (CUSTOMARY, tracked in `THIRD_PARTY.md` and `THIRD_PARTY-research.md`):**
- A Python file copied or adapted from `mvanhorn/last30days-skill` starts with a banner: `VENDORED`, `ADAPTED` or
  `REIMPLEMENTED`, the upstream path, licence, pinned commit and the `gh api` command to see later upstream changes
  (`apps/research/app/http.py`, `apps/research/app/pipeline/dedupe.py`). A new borrowed file needs its row in the ledger.

**JSDoc / docstrings:**
- TypeScript uses `/** ... */` for rationale and field meaning, not for parameter lists. Python modules open with a docstring
  that states the rule the module enforces (`apps/research/app/errors.py`).
- The repository is public: no personal data, local paths, session ids or secrets in a comment, a doc or a commit message.

## Function Design

**Size and shape:**
- Decisions are small pure functions that take data and return data: `decideGate`, `buildHandoff`, `analyzeBlockers`,
  `reconcileTasks`, `buildCanvasGraph`. The one impure function in a module is thin and takes its I/O as a parameter.
- Early returns over nesting; named conditions over nested ternaries (`noNestedTernary` is enforced).

**Parameters:**
- Seam functions take `(deps, input)`: `evaluateGate(deps: GateDeps, input)` in `apps/chat/lib/phases/gate.ts`,
  `generatePersona({ generate, onError }, input)` in `apps/chat/lib/personas/generate.ts`. `deps` holds the injected
  model call or fetch (`GateJudge`, `FactExtractor`, `PersonaGenerator`, `SidecarConfig.fetchImpl`).
- Time is a parameter, not a call: `buildHandoff` receives `generatedAt`; `planResearchClock` receives a clock function.

**Return values:**
- A tagged union for anything that can refuse or be unknown; a plain value only when failure is impossible.

## Module Design

**Exports:** named exports. `"use client"` only on interactive components; everything else stays a Server Component
(`apps/chat/AGENTS.md`). Components live under `apps/chat/components/<feature>/`; shadcn primitives stay in
`apps/chat/components/ui` (config `apps/chat/components.json`).

**Barrel files:** none (see the Enforcement Map).

**Where the logic lives:** put domain logic in `apps/chat/lib/<domain>/` as pure `.ts`, and keep the React file a thin
renderer. A component's testable logic is split into a `.ts` beside it
(`apps/chat/components/research-run-summary.ts` and its test).

**Config and env:** read env through `env.VAR` from `apps/chat/lib/env.ts` (`@t3-oss/env-nextjs` over
`apps/chat/lib/env-schema.ts`); feature flags and integration config live in `apps/chat/lib/config.ts` /
`apps/chat/chat.config.ts`. A new env var goes in four places: `apps/chat/lib/env-schema.ts`, the root `.env.example`,
`turbo.json` `globalEnv` (TESTED by `env-schema.test.ts`) and `apps/chat/scripts/check-env.ts` when a feature needs it
(`.claude/rules/env-config.md`). Several gateway files under `apps/chat/lib/ai/gateways/` still read `process.env`
directly; that is existing code, not the pattern to copy.

## Commits, Branches and Docs

- Commit subject is one sentence naming the defect fixed, for example "A chat turn could make the server fetch any URL,
  including loopback, private-network and cloud-metadata addresses"; the body says what changed and how it was checked
  (`CONTRIBUTING.md`). CUSTOMARY.
- One concern per commit. Big or multi-file work on `feat|fix|chore/<slug>-<YYMMDD>`; open the PR against `main`.
- A hard-to-reverse choice gets a new ADR in `docs/ADR/` (accepted ADRs are not edited); an incident gets an entry in
  `docs/INCIDENTS.md` with its guard, and a bug fix ships with the guard test (`CONTRIBUTING.md`, "Tests").
- Changing a schema, env var, research source, phase or top-level module means updating the doc that owns it in the same
  commit: the table in `.claude/rules/docs-sync.md`.
- Before pushing: `bun run verify` and the relevant tests (`AGENTS.md`). Run a production build only right before a push.

## Where Docs and Code Disagree

Follow the code.

- `apps/chat/AGENTS.md` says to remove `console.log`; `noConsole` is `off` in `ultracite/core` and two production files
  still call it (see Logging).
- `apps/chat/AGENTS.md` says to prefer `env.VAR` over `process.env`; the gateways and `apps/chat/lib/ai/providers.ts` read
  `process.env` and no rule forbids it.
- `apps/chat/AGENTS.md` says not to commit `.only` or `.skip` and to keep assertions inside test cases, but
  `apps/chat/biome.jsonc` does not extend `ultracite/vitest`, so Biome does not check either. Only
  `scripts/test-integrity.sh` (pull requests) and Playwright's `forbidOnly` (when `CI` is set) catch a focus marker, and
  skip markers that already exist are tolerated (see `TESTING.md`).
- `CONTRIBUTING.md` says any branch name works; `CLAUDE.md` asks for `feat|fix|chore/<slug>-<YYMMDD>`. Nothing enforces
  either.

---

*Convention analysis: 2026-11-12*
