<!-- refreshed: 2026-11-12 -->
last_mapped_commit: c9be663d

# Testing Patterns

**Analysis Date:** 2026-11-12

Test counts change with every commit and are not recorded here. To get them: read the summary line each runner prints
(vitest, `bun test`, pytest), run `cd apps/research && .venv/bin/python -m pytest --collect-only -q` for the Python
total, or run `bash scripts/test-integrity.sh <base>`, which prints `TypeScript cases A -> B, Python cases C -> D`
whenever a test file differs from `<base>`.

## Test Framework

| Package | Runner | Config | Script |
|---|---|---|---|
| `apps/chat` (unit) | vitest `^4.0.0` | `apps/chat/vitest.config.ts` (plugin `vite-tsconfig-paths`; excludes `**/node_modules/**` and `**/*.e2e.ts`; default `node` environment, no setup file) | `bun run test:unit` = `vitest run` |
| `apps/chat` (e2e) | Playwright `@playwright/test ^1.50.1` | `apps/chat/playwright.config.ts`, specs in `apps/chat/tests/*.e2e.ts` | `bun run test:e2e` |
| `apps/chat` (evals) | evalite `1.0.0-beta.8` | `apps/chat/evalite.config.ts`, files `apps/chat/evals/*.eval.ts` | `bun run eval:gate` (paid) |
| `packages/thread` | `bun test` (`bun:test`) | none; `test/` folder | `bun run test:unit` |
| `packages/cli` | `bun test` (`bun:test`) | none; `src/**/*.test.ts` | `bun run test:unit` (runs `template:sync` first) |
| `.agents/skills/worktree-ports/scripts` | `bun test` | none | run by the root `test:unit` script |
| `apps/research` | pytest `>=8.3,<9.0` with `httpx` for `TestClient` | `[tool.pytest.ini_options]` in `apps/research/pyproject.toml` (`testpaths = ["tests"]`, `addopts = "-q"`) | `.venv/bin/python -m pytest` |
| `.claude/hooks/*.sh` | plain bash | none | `bash .claude/hooks/hooks.test.sh` (by hand) |
| `packages/registry` | none | no test script | n/a |

**Assertion libraries:** vitest `expect` in `apps/chat`; `bun:test` `expect` in the packages; plain `assert` and
`pytest.raises` in Python. There is no snapshot testing and no DOM testing library.

**Run commands (local):**
```bash
bun run verify                          # lint + type-check (apps/chat, packages/thread) + ruff if apps/research/.venv exists
bun run test:unit                       # worktree-port script test, then turbo: vitest (apps/chat), bun test (packages/thread, packages/cli)
bunx turbo run test:unit --force        # same, bypassing turbo's cache (a cache hit replays old output)
cd apps/chat && ./node_modules/.bin/vitest run lib/phases/gate.test.ts   # one file
cd apps/chat && ./node_modules/.bin/vitest                               # watch mode
cd apps/research && .venv/bin/python -m pytest                           # sidecar suite
cd apps/research && .venv/bin/python -m pytest tests/test_gate.py -k TestDefaultPosition   # one class
cd apps/research && .venv/bin/python -m ruff check app tests            # sidecar lint
bun run test:e2e                        # Playwright; needs Docker Postgres, not part of CI
bash scripts/test-integrity.sh main     # the PR guard, against the branch you target
bash .claude/hooks/hooks.test.sh        # the hook scripts' own tests (not in CI)
```
- Inside `apps/chat`, never run a bare `bun test`: that is Bun's own runner, not vitest (`apps/chat/AGENTS.md`).
- `bun run test:types` deletes `apps/chat/.next/dev/types`; never run it beside a dev server. `bun run verify` is safe.
- `packages/thread/test/package-smoke.test.ts` reads `packages/thread/dist/index.js` and throws if it is missing. It does
  not build. Run it through turbo (`packages/thread/turbo.json` makes `build` a dependency of `test:unit`) or run
  `bun run build` in `packages/thread` first.
- `packages/cli` `test:unit` runs `bun run template:sync`, which writes the gitignored `packages/cli/templates/` from
  `apps/chat` (`scripts/sync-template.ts`, `.gitignore`).
- The unit suites need no database, no network and no API key. To prove the key claim, `README-DEV.md` gives
  `cd apps/chat && env -u AI_GATEWAY_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY ./node_modules/.bin/vitest run`.
  `vitest.config.ts` does not clear those variables itself.
- Python needs the venv: `apps/research/.venv` (setup in `apps/research/README.md`). The optional `simulation` extra is not
  needed and is not installed in CI.

## CI (`.github/workflows/ci.yml`)

Triggers: `pull_request` (opened, synchronize, reopened, labeled, unlabeled) and `push` to `main`. No secrets, no
database, no services, no `schedule`, `workflow_run` or `release` trigger. Actions are pinned to full commit SHAs.

| Job | Runs when | What it runs |
|---|---|---|
| `changes` | always | `dorny/paths-filter` on PRs; outputs `typescript`, `python`, `integrity`. A push to `main` runs both language jobs and skips `integrity`. |
| `typescript` | PR touches `apps/chat/**`, `packages/**`, `scripts/**`, `.agents/skills/worktree-ports/**`, `.worktree-env.json`, `package.json`, `bun.lock`, `turbo.json` or `.github/workflows/**`; or a push to `main` | `bun install --frozen-lockfile`, `bun run verify`, `bun run test:unit` (Bun version from the `packageManager` field of `package.json`) |
| `python` | PR touches `apps/research/**` or `.github/workflows/**`; or a push to `main` | Python 3.11, `python -m venv .venv`, `pip install -e ".[dev]"`, `ruff check app tests`, `pytest` (working directory `apps/research`) |
| `integrity` | pull requests only | `scripts/test-integrity.sh "$BASE_SHA" HEAD`, with `TEST_REMOVAL_APPROVED` set from the `test-removal-approved` label; checkout depth 2 plus a fallback fetch of the base |
| `ci-success` | always (`if: always()`) | Passes when each needed job succeeded, or was skipped because `changes` said so. This is the one required check (`.github/rulesets/main.json`). |

- A docs-only PR runs neither language job and still passes `ci-success`. Never add `paths-ignore` at workflow level: a
  skipped workflow leaves the required check pending (header of `ci.yml`).
- In CI `verify` skips its Python step (no `apps/research/.venv`); the `python` job owns it. `verify` prints
  `SKIPPED: apps/research ruff check...` and still passes.
- A new push to a PR cancels the superseded run; a push to `main` gets its own concurrency group per commit.
- **Not run in CI:** Playwright e2e, `bun run build`, `bun run test:types`, `bun run template:check`, the evals,
  `.claude/hooks/hooks.test.sh`, `ruff format`, and any migration replay against a database
  (`.claude/rules/db.md`: "No test replays the chain against an empty database").
- **Coverage:** not configured. No coverage provider in `apps/chat/package.json`, no threshold in
  `apps/chat/vitest.config.ts` or in pytest's `addopts`, and no coverage step in CI.

## Test-Integrity Check (`scripts/test-integrity.sh`)

Runs on pull requests (job `integrity`) and locally with `bash scripts/test-integrity.sh <base> [head]`. It compares the
merge-base of `<base>` and `<head>` with `<head>` and fails (exit 1) on any of:

1. **A deleted test file.** Test files are `*.test.ts`, `*.test.tsx`, `*.e2e.ts` anywhere in the tree, and
   `apps/research/tests/*.py` except `__init__.py`.
2. **A new skip or focus marker in a test file** (compared per file against the base, renames followed with `-M`).
   TypeScript: `it|test|describe` followed by `.only`, `.skip`, `.skipIf`, `.fixme`, and `xit`, `xtest`, `xdescribe`,
   `fit`, `fdescribe`. Python: `pytest.mark.skip`, `skipif`, `xfail`, `pytest.skip(`, `unittest.skip`.
3. **A lower total number of test cases.** TypeScript counts `it(` / `test(` (and `.each`) declarations in the three
   file kinds above; Python counts `def test_` in `apps/research/tests`. `it.skip(` is not counted as a case.

Exit codes: 0 ok, 1 the change weakens the tests, 2 usage or git error.

- The `test-removal-approved` label (a maintainer adds it; CI re-runs on `labeled` / `unlabeled`) waives rules 1 and 3.
  Rule 2 is never waived.
- Limits stated in the script: it counts declarations, not assertions, so an emptied test body is invisible; and a PR can
  edit the script, so review of `scripts/` and `.github/` is part of the guard.
- It does not see `*.eval.ts`, `packages/thread/test/use-thread-types.ts` (type-level, no `.test.ts` suffix), or bash tests.
- Skip markers that already exist are tolerated because only an increase per file fails: `describe.skipIf` in
  `apps/chat/lib/env-schema.test.ts`, `it.skip` and `describe.skip` in `packages/cli/src/helpers/scaffold.test.ts`,
  and `pytest.skip(` inside `apps/research/tests/test_api.py` and `apps/research/tests/test_simulation.py` (both skip when
  the optional OASIS install is present). Adding one more marker to any of those files, or a marker to a new file, fails.
- Playwright adds its own guard: `forbidOnly: !!process.env.CI` in `apps/chat/playwright.config.ts`.
- `apps/chat/biome.jsonc` does not extend `ultracite/vitest`, so no lint rule checks `.only`, `.skip` or assertions outside
  a test; this script is the only automatic check.

## Test File Organization

**Location:** co-located. A unit test sits beside its subject and shares its name.

```
apps/chat/
├── chat.config.test.ts                 # root-level guard for chat.config.ts
├── lib/<domain>/<name>.ts + <name>.test.ts    # phases, export, personas, signals, ultraplan, db, ai, credits, research
├── tools/platform/deep-research/*.test.ts
├── components/research-run-summary.ts + .test.ts   # logic split out of a component so it is testable
├── tests/*.e2e.ts                      # Playwright specs and setup files
├── evals/*.eval.ts, evals/setup.ts, evals/fixtures/   # evalite, not part of test:unit
packages/thread/test/*.test.ts          # plus test/use-thread-types.ts (type-level, checked by tsc)
packages/cli/src/**/*.test.ts
apps/research/tests/test_*.py           # flat; __init__.py present; no conftest.py
```

**Naming:** `<subject>.test.ts` (kebab-case, enforced by `useFilenamingConvention`); `<subject>.e2e.ts`; `<subject>.eval.ts`;
`test_<area>.py` (`test_adapters.py`, `test_api.py`, `test_gate.py`, `test_pipeline.py`, `test_simulation.py`).
Vitest's default include (`*.test.*`) does not match `*.eval.ts`, and `vitest.config.ts` excludes `*.e2e.ts`, so neither
runs under `test:unit`.

**Linted and type-checked like source:** `apps/chat` tests, e2e specs and evals are covered by `ultracite check` and
`tsc --noEmit` (`apps/chat/tsconfig.json` includes `**/*.ts`). Test files get relaxed `noExplicitAny`, `noConsole` and
complexity rules from the override in `ultracite/core`.

## Test Structure

**Suite organization (vitest):** `describe` names the unit and the behaviour, `it` is a sentence. An em dash after the
unit name is common.

```typescript
// apps/chat/lib/phases/gate.test.ts
describe("decideGate — the pure gate", () => {
  it("BLOCKs a vague idea and names the specific gap", () => {
    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate,
      factCount: FACTS.length,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.missing).toContain(gapText);
    expect(verdict.reason).toMatch(RE_ONE_UNMET);
  });
});
```

**Patterns (CUSTOMARY unless stated):**
- Open the file with a block comment that states the defect or invariant the file locks and why a weaker test would pass
  by accident (`apps/chat/lib/phases/runtime.test.ts`, `apps/chat/lib/db/phase-attempt.test.ts`).
- Build inputs with small local factory functions that take `overrides: Partial<T> = {}` (`ev()`, `fact()`, `persona()`);
  start from an all-valid baseline and perturb one thing (`allMet()` then change one criterion).
- Hoist every regex to a module-level constant, usually `RE_*` (`useTopLevelRegex` is ENFORCED, so an inline regex literal in
  a hot scope fails lint): `const RE_ONE_UNMET = /1 of 8 exit criteria are unmet/;`.
- Assert the specific outcome and the reason text, not only the decision; assert the model was NOT called when a guard
  should refuse first (`expect(generate).not.toHaveBeenCalled()` in `apps/chat/lib/personas/generate.test.ts`).
- Time is fixed: a module-level `const AT = new Date("2026-08-01...")` (a literal ISO date). No test uses fake timers; clocks are injected instead.
- Restore globals in `afterEach`: `vi.unstubAllEnvs(); vi.unstubAllGlobals();` (`apps/chat/lib/ai/gateways/vercel-gateway.test.ts`).
- `bun:test` files (`packages/*`) import `describe`, `it` / `test`, `expect`, `mock`, `afterEach` from `"bun:test"`; temp
  directories come from `tmpdir()` plus `crypto.randomUUID()` and are removed in `afterEach`
  (`packages/cli/src/helpers/scaffold.test.ts`). `packages/thread` renders hooks with `react-test-renderer` and
  `act` (`packages/thread/test/use-thread.test.ts`).

**Pytest:** group by subject in `class Test<Subject>:`, name tests as sentences (capitals for emphasis are common:
`test_a_404_from_the_provider_is_a_NAMED_condition`), use `monkeypatch` and `pytest.raises(...) as caught` then assert
`caught.value.kind` (`apps/research/tests/test_simulation.py`). Helpers such as `persona(**overrides)`, `body()` and
`deployment(...)` sit at the top of each file; fixtures are defined per file (there is no `conftest.py`).

## Mocking

**Framework:** `vi` (vitest) in `apps/chat`; `mock` from `bun:test` in `packages/thread`; `monkeypatch` in pytest. The
primary technique is **dependency injection at a named seam**, with module mocks only where a module reaches a database,
the env or `server-only`.

**Seams for model and network calls (all in-repo; nothing needs a key):**

| Seam | Defined in | How a test drives it | Example |
|---|---|---|---|
| Gate judge | `GateJudge` (`(request) => Promise<unknown>`) in `apps/chat/lib/phases/gate.ts`; `evaluateGate(deps, input)` | pass an async closure, or `createModelGateJudge({ model })` from `apps/chat/lib/phases/model-adapters.ts` over `MockLanguageModelV3` | `apps/chat/lib/phases/gate.test.ts`, `model-adapters.test.ts` |
| Fact extractor | `FactExtractor` in `apps/chat/lib/phases/extract.ts` | closure returning `Promise.resolve({...})`, including a malformed `{ nope: true }` | `apps/chat/lib/phases/extract.test.ts` |
| Persona generator | `PersonaGenerator`, `PersonaDeps` in `apps/chat/lib/personas/generate.ts` | `vi.fn<PersonaGenerator>(() => Promise.resolve({}))` plus an `onError` collector | `apps/chat/lib/personas/generate.test.ts` |
| Post-turn wiring | `runPostTurnPhasePass` in `apps/chat/lib/phases/runtime.ts` | `vi.mock` of `server-only`, `@/lib/db/phase-queries`, `@/lib/db/queries`, `@/lib/ai/providers` (its `getLanguageModel` returns a `MockLanguageModelV3`), `@/lib/embeddings/provider`; the real gate, extractor and `generateText` still run | `apps/chat/lib/phases/runtime.test.ts` |
| Sidecar HTTP (TypeScript side) | `SidecarConfig.fetchImpl` in `apps/chat/lib/signals/sidecar.ts`; `fetchImpl` in `apps/chat/lib/research/sidecar-simulation.ts` | pass a function returning `new Response(JSON.stringify(body), { status })` or rejecting with `new Error("ECONNREFUSED")` | `apps/chat/lib/signals/sidecar.test.ts` |
| Deep-research sidecar search | `apps/chat/tools/platform/deep-research/sidecar-search.ts` | `vi.mock("@/lib/config", ...)` with an inline config object (factories are hoisted, so no outer constants) and `vi.mock("@/lib/env", () => ({ env: {} }))` | `apps/chat/tools/platform/deep-research/sidecar-search.test.ts` |
| Provider HTTP | `apps/chat/lib/ai/gateways/*` | `vi.stubGlobal("fetch", vi.fn(...))`, `vi.stubEnv(...)`, unstub in `afterEach` | `apps/chat/lib/ai/gateways/vercel-gateway.test.ts` |
| Env validation | `apps/chat/lib/env.ts` | `vi.mock("@/lib/env", () => ({ env: { ... } }))` before importing a module that validates env at load (`schema.ts` does, through `encrypted-text`) | `apps/chat/lib/db/phase-attempt.test.ts` |
| Clock | `planResearchClock(deadline, now)`, `buildHandoff({ generatedAt })` | pass a fixed value or `() => start` | `apps/chat/tools/platform/deep-research/research-clock.test.ts`, `apps/chat/lib/export/handoff.test.ts` |
| Python adapter HTTP | `get_json` in `apps/research/app/http.py`, `_get_payload` in `apps/research/app/sources/arctic_shift.py` | `monkeypatch.setattr(arctic_shift, "get_json", fake_get_json)` | `apps/research/tests/test_adapters.py` |
| Python routes | `resolve_permitted_source` in `apps/research/app/main.py` | `monkeypatch.setattr(main, "resolve_permitted_source", lambda *_: Fake())`; after changing env, `importlib.reload(importlib.import_module("app.main"))`; `TestClient(main.app, client=("127.0.0.1", 50000))` because the default peer name is refused by `require_caller` | `apps/research/tests/test_api.py` |
| Python simulation | `apps/research/app/simulation/oasis_runner.py` | OASIS is imported lazily, so the suite asserts the named `oasis-not-installed` condition; fake `camel` modules are installed with `monkeypatch.setitem(sys.modules, ...)` and `urllib.request.urlopen` is patched | `apps/research/tests/test_simulation.py` |

**Pattern for a seam test with a real SDK model double:**
```typescript
// apps/chat/lib/phases/runtime.test.ts (shape of the helper; each file defines its own copy)
function mockModel(body: string) {
  return new MockLanguageModelV3({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: "text" as const, text: body }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      }),
  });
}
```
`MockLanguageModelV3` comes from `"ai/test"`. In `ai` 6, `finishReason` must be `{ unified, raw }` and token counts must be
per-category objects; a bare `"stop"` makes `generateText` skip structured-output parsing and `result.output` throws
`AI_NoOutputGeneratedError` (comment in `apps/chat/lib/phases/model-adapters.test.ts`). Read what the model was shown with
`model.doGenerateCalls.at(-1)?.prompt`.

**Declaring module mocks:** `vi.mock` is hoisted above imports. Create the spies first with `vi.fn()` or `vi.hoisted(...)`,
wrap them in the factory (`(...args: unknown[]) => spy(...args)`), then import the module under test after the `vi.mock`
calls (`apps/chat/lib/phases/runtime.test.ts`, `apps/chat/lib/clone-messages.test.ts`).

**What to mock:**
- Anything that needs a key, a socket or Postgres: model providers, `fetch`, the sidecar, the DB query modules, `env`,
  `server-only`.

**What NOT to mock:**
- The pure core. The gate, Zod schemas, `generateText` and `Output.object` parsing run for real, so a regression in the
  wiring is caught (`apps/chat/lib/phases/runtime.test.ts` header: "Nothing here is mocked out").
- Do not re-type production SQL or config in the test and assert against the copy. Assert on the exported object (the real
  drizzle table config via `getTableConfig`, the exported `PROJECT_FACT_UPSERT_SET` clause).

## Fixtures and Factories

**Test data:** inline factory functions beside the tests; no shared test-utils module, so each file defines its own
`mockModel`, `ev`, `fact`, `persona`. Copy the nearest one.

```typescript
// apps/chat/lib/personas/generate.test.ts
const AT = new Date("2026-08-01...");   // a literal ISO date in the real file
function fact(key: string, value: string): StoredFact {
  return { key, value, confidence: 80, updatedAt: AT, phaseKey: PHASE_THREE.key };
}
```

**Location:**
- Eval transcripts: `apps/chat/evals/fixtures/gate-phase-01.ts`.
- Python builders live at the top of each `apps/research/tests/test_*.py`.
- Real definitions are reused rather than copied: tests import `PHASE_ONE`, `PHASES` from
  `apps/chat/lib/phases/definitions.ts`, so a phase change is exercised by existing tests.
- `bun run db:seed` (`apps/chat/scripts/seed-demo.ts`) creates dev data; it is not a test fixture and no unit test touches
  Postgres.

## Test Types

**Unit tests (the bulk):** pure functions and injected seams, no I/O. Where the subject is a React component, the testable
logic is moved to a `.ts` file next to it (`apps/chat/components/research-run-summary.ts`), because vitest runs in the
`node` environment with no DOM library. Only `packages/thread` renders hooks (`react-test-renderer`).

**Guard and census tests:** a test whose job is to stop a specific defect returning (the repository's rule: a bug fix ships
with the guard that would have failed). Kinds in use:
- Census across files: `apps/chat/lib/env-schema.test.ts` reads the root `turbo.json` and requires every key of
  `serverEnvSchema` to be in `globalEnv` (skipped when there is no `turbo.json`, i.e. `apps/chat` copied out of the
  monorepo).
- Invariant pins: `apps/chat/lib/phases/definitions.test.ts` (8 phases, disjoint fact keys, every criterion states a
  closure), `apps/chat/lib/phases/definitions-wording.test.ts`, `apps/chat/lib/config-schema.test.ts`.
- Fail-closed behaviour: `apps/chat/lib/phases/gate.test.ts`, `apps/chat/lib/phases/extract.test.ts`,
  `apps/chat/lib/research/simulation.test.ts` (`usableAsEvidence` is always false).
- Structure of the schema read from the real drizzle table config (`getTableConfig`), with no database:
  `apps/chat/lib/db/phase-attempt.test.ts`, `apps/chat/lib/db/simulation-profile.test.ts`. The upsert clause is checked as
  an exported object in `apps/chat/lib/db/fact-upsert.test.ts`; the founder-assertion planner is pure and also carries a
  compile-time proof in `apps/chat/lib/db/fact-assertion.test.ts`.
- Path-safety for the export: `apps/chat/lib/export/paths.test.ts` (traversal, reserved names, bidi override).
- Source-text assertions exist but are the weakest form (`apps/chat/chat.config.test.ts` reads `lib/ai/core-chat-agent.ts`
  and checks for a string); prefer an assertion on behaviour.
- Legal-position tests in Python: `apps/research/tests/test_gate.py` ("do not adjust the test; read
  `app/sources/reddit_gate.py`").
- Contract mirrors: `apps/research/tests/test_api.py` and `apps/chat/lib/signals/sidecar.test.ts` assert the same wire
  shapes from both ends. No test reads both languages for the four-place source-id list; that is checked by hand
  (`.claude/rules/research-sources.md`).

**Type-level tests:** `// @ts-expect-error` lines prove a type refuses something. They are checked by `tsc --noEmit`
(inside `bun run verify`), not by the test runner, so an unused directive fails type-checking
(`apps/chat/lib/db/fact-assertion.test.ts`, `packages/thread/test/use-thread-types.ts`).

**Package smoke test:** `packages/thread/test/package-smoke.test.ts` packs the built package with `bun pm pack` and imports
its entry points in a temp directory.

**E2E (Playwright, local only):** a small smoke suite.
- Config: `apps/chat/playwright.config.ts`. Projects `chat`, `reasoning`, `artifacts`, each with a `testMatch` regex on
  its own file in `apps/chat/tests/`. `testDir` is `./tests`, `fullyParallel: true`, `retries` 1 locally and 2 when `CI`
  is set, `workers: 1` when `CI` is set, trace on first retry, HTML reporter.
- Timeouts are 60 s for a test and for `expect` (the comment beside them says 30 s; the value is 60).
- It starts the app itself: `webServer.command` is `bun run dev:local`, URL `http://localhost:${PORT}` with `PORT`
  defaulting to 3100, `reuseExistingServer: !process.env.CI`. Needs the Docker Postgres and a one-time
  `cd apps/chat && bunx playwright install`.
- `bun run test:e2e` at the root wraps the worktree port script and turbo; in `apps/chat` it is
  `export PLAYWRIGHT=True && bunx playwright test --workers=4`. `PLAYWRIGHT`, `PLAYWRIGHT_TEST_BASE_URL` and `CI_PLAYWRIGHT`
  switch off the auth guard and supply test defaults (`apps/chat/lib/playwright-test-environment.ts`,
  `.claude/rules/auth.md`); never set them outside a test run.
- `apps/chat/tests/auth.setup.e2e.ts` and `reasoning.setup.e2e.ts` are matched by no project's `testMatch` and no project
  lists them as a dependency, so they never run.
- Specs use role locators first (`getByRole("textbox")`), `getByTestId` when roles are ambiguous, and a comment explaining
  the defect the assertion locks (`apps/chat/tests/chat.e2e.ts`). Artefacts `playwright-report/`, `test-results/` and
  `playwright/` are gitignored.

**Evals (paid, manual):** `apps/chat/evals/gate-calibration.eval.ts` runs the real judge over
`apps/chat/evals/fixtures/gate-phase-01.ts` fixtures with exact-enum comparison, on the chat model from
`apps/chat/chat.config.ts`. `bun run eval:gate` (`evalite run --noCache`) makes real OpenAI calls and spends credits; run it
only when asked and after a prompt, model or gate change. `apps/chat/evals/setup.ts` loads the repo-root env file and mocks
`server-only`; history is a sqlite file under `apps/chat/evals/db/` (gitignored). Never run it as a check.

**Hook scripts:** `.claude/hooks/hooks.test.sh` builds throwaway git repos under `mktemp -d`, pipes real hook payloads into
each script and checks exit codes; it runs with the bash that launches it (`HOOK_TEST_SHELL=/bin/bash` for macOS bash 3.2).

## Common Patterns

**Async testing (vitest):** return the promise or `await` it; stub the seam with an already-resolved promise.
```typescript
// apps/chat/lib/signals/sidecar.test.ts
fetchImpl: () => Promise.resolve(new Response("{}", { status: 401 })),
fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
```
`useAwait` is ENFORCED, so a mock that returns a value synchronously is written as `Promise.resolve(...)`, not `async () => ...`.

**Error testing:**
```typescript
// apps/chat/lib/phases/gate.test.ts: a judge that throws still yields a verdict
it("fails CLOSED when the judge throws", async () => {
  const judge: GateJudge = () => Promise.reject(new Error("no api key"));
  const verdict = await evaluateGate({ judge }, input);

  expect(verdict.decision).toBe("BLOCK");
  expect(verdict.reason).toMatch(RE_FAILED_CLOSED);
});
```
```python
# apps/research/tests/test_simulation.py
with pytest.raises(SimulationUnavailable) as caught:
    run_simulation([persona("a"), persona("b")], "a pitch")
assert caught.value.kind == "oasis-not-installed"
```
Assert the named condition (`kind`) and that the message names the variable or command the operator needs.

**Env and secrets in tests:** use placeholder strings (`"test-key"`, `"sk-test"`) and `vi.stubEnv` / `monkeypatch.setenv`;
never read `.env.local`. Tests that prove a secret does not leak assert it is absent from the payload
(`test_never_leaks_a_credential_value` in `apps/research/tests/test_api.py`).

## What to Run

| You changed | Run |
|---|---|
| any TypeScript or CSS in `apps/chat` or `packages/thread` | `bun run verify`, then the nearest `vitest run <file>` |
| `apps/chat/lib/phases/**`, `prompts/**` | `vitest run lib/phases`; read `.claude/rules/phases-gate.md`; do not run `bun run eval:gate` unless asked |
| `apps/chat/lib/db/schema.ts` or migrations | `bun run verify`, `vitest run lib/db`; replay the migration on a throwaway `pgvector/pgvector:pg17` container (`.claude/rules/db.md`, `docs/DATABASE.md`) |
| a new env variable | `vitest run lib/env-schema.test.ts` (checks `turbo.json`) |
| `apps/research/**` | `.venv/bin/python -m ruff check app tests` and `.venv/bin/python -m pytest` from `apps/research` |
| a user flow in the app | `bun run test:e2e` locally |
| anything before a PR | `bun run verify`, `bun run test:unit`, `bash scripts/test-integrity.sh main` |

## Where Docs and Code Disagree

Follow the code.

- `CLAUDE.md` describes `bun run test:unit` as "vitest in apps/chat, bun test in packages". It also runs the worktree-port
  script's test first and, through `packages/cli`, regenerates `packages/cli/templates/`.
- `apps/chat/AGENTS.md` says not to commit `.only` / `.skip`; only `scripts/test-integrity.sh` (pull requests) and
  Playwright's CI-only `forbidOnly` enforce it, and existing skips are tolerated.
- `apps/chat/tests/auth.setup.e2e.ts` and `reasoning.setup.e2e.ts` read as the auth setup for the e2e projects, but no
  project wires them in; the suite relies on the Playwright environment variables switching auth off.
- `.claude/rules/db.md` says no test replays the migration chain against an empty database; there is no such test and no
  CI job for it.

---

*Testing analysis: 2026-11-12*
