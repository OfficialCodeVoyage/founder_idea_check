# Agent-operating setup

How this repo's agent structure was built (2026-11-12, `chore/agent-setup-261112`), following the owner's
foundation guide. Facts line: existing code, one developer, public open-source repo, a fork with an `upstream`
remote (push disabled), Bun/TypeScript monorepo plus a Python sidecar.

## Mapping table

| Item | Found | Done |
|---|---|---|
| `CLAUDE.md` | none | Created (≤200 lines): `@AGENTS.md`, then a `## Claude Code` section. No Working rules block (the global layer has it). |
| `AGENTS.md` | upstream title; told agents to run `bun test:types` | Retitled; points at `bun run verify`; warns that `test:types` deletes the dev server's types. |
| `apps/chat/AGENTS.md` | told agents to run `db:migrate` when in scope | Replaced with the hand-written-migration rule; `bun test` vs `test:unit` trap added. Next.js block kept. |
| `.claude/settings.json` | one PostToolUse hook: whole-repo `bun run format` + `bun run test:types` after every edit | Replaced: secret deny rules, ask on push, SessionStart orientation + compact restore, push guard (`onFailure: block`), single-file Biome format hook. |
| `.claude/rules/` | none | db, auth, phases-gate, research-sources, export, env-config, docs-sync. |
| `.claude/hooks/` | none | Kit copies (byte-identical) + `format-on-edit.sh`. |
| `verify` | none (`bun lint` + `bun test:types`, the latter unsafe beside dev) | `bun run verify` → `scripts/verify.sh`. |
| `.planning/` | none | STATE.md, DEFERRED-BY-BLOCKER.md (Section F), this file. Public: nothing private here. |
| `docs/` | upstream docs app removed; many root notes | ARCHITECTURE.md, ADR/README + 0001, INCIDENTS.md (template). Root notes fold into `docs/` during the release clean-up. |
| `CONTEXT.md` | none | 25-term glossary. |
| `RECONSTRUCTION.md`, `.planning/codebase/` | none | Deferred to the end of the release clean-up so they map the code that ships; stamped after the history rewrite. |
| `.codex/`, `.cursor/` hooks | run `scripts/ai-post-codegen.sh` (whole-repo format + `test:types`) | `ai-post-codegen.sh` now runs `bun run verify` (no whole-repo format, no `test:types`). |
| CI | 9 upstream workflows, 2 for removed apps, no Python job | Replaced by one `.github/workflows/ci.yml` with a single `ci-success` check (`chore/ci-community-261112`). Not yet run on GitHub. |
| Memory | none | `MEMORY.md` + `reference_docs_index.md` (machine-local). |

## Stack research

| Fact | Source |
|---|---|
| Next.js 16.3.0: `next typegen` writes `.next/types` (verified by running); `next dev` writes `.next/dev/types`; dev and build use separate dirs and a lockfile stops two `next dev` on one app | https://nextjs.org/docs/app/guides/upgrading/version-16, https://nextjs.org/docs/app/api-reference/cli/next |
| Next 16: `middleware.ts` → `proxy.ts`; a matcher exclusion also skips Server Function calls on that path | https://nextjs.org/docs/app/api-reference/file-conventions/proxy |
| Bun 1.3: a built-in command wins over a same-named script (`bun test` in `apps/chat` runs Bun's runner) | https://bun.com/docs/cli/run, https://bun.com/docs/cli/test |
| turbo 2.9.5: strict env mode by default; only `env`/`globalEnv` vars reach tasks | https://turborepo.dev/docs/crafting-your-repository/using-environment-variables |
| drizzle-kit 0.31.10 uses the legacy flat migration layout; current docs describe v1 folders. Do not run `drizzle-kit up`. The migrator runs all pending files in one transaction (installed `drizzle-orm/pg-core/dialect.js`) | https://orm.drizzle.team/docs/kit-overview, https://orm.drizzle.team/docs/upgrade-v1 |
| better-auth 1.6.2: `nextCookies` must be the last plugin; cookie-bearing requests from untrusted origins get 403 `INVALID_ORIGIN` (installed `origin-check.mjs`) | https://www.better-auth.com/docs/integrations/next |
| vitest 4.1.4 (current docs are v5; v5 changes do not apply) | https://v4.vitest.dev/guide/migration |
| Biome 2.4.10 via ultracite 7.4.3: `biome format --write <file>` formats one file; ignored files are skipped with `--no-errors-on-unmatched` (verified by running) | https://biomejs.dev/reference/cli/ |
| Ruff 0.16.3 in the venv: `ruff check app tests` clean; `ruff format --check` would change 11 files (not enforced) | https://docs.astral.sh/ruff/formatter/ |
| Global review gate covers ts/tsx/js/jsx/mjs/cjs/sql/css only: Python is outside it | global layer |
| LSP plugins: `typescript-lsp` (binary `typescript-language-server`), `pyright-lsp` (binary `pyright-langserver`) | foundation guide §5 |
| Context7 was not connected; facts came from the official pages above and installed package source | — |

## Measured baselines (2026-11-12)

- `bun run verify`: all pass in 13 s (Python step skipped in a worktree without `apps/research/.venv`); exits 1 on a
  deliberate type error.
- `bun run test:unit`: chat 1,255 passed (79 files), thread 58, cli 31, worktree-runtime 13; 0 failed.
- `pytest` (from the QA batch): 126 passed, 2 skipped.
- Hook suite: `323 passed, 0 failed` on bash 5 and `/bin/bash` 3.2.

## Findings recorded for the release work

- `bun install --frozen-lockfile` failed: `bun.lock` was stale against `package.json` (an overrides comment moved
  out of `overrides` without regenerating the lockfile). Fixed by regenerating it with the local Bun.
- `@better-auth/core` is forced to 1.5.6 while `better-auth` resolves 1.6.2; the recorded reason (the Electron
  app) no longer applies.
- `turbo.json` `globalEnv` misses `RESEARCH_ENABLED_SOURCES`, `LITELLM_*`, `VERCEL_SANDBOX_RUNTIME_*`.
- `.cursor/mcp.json` ran `next-devtools-mcp@latest` unpinned. Fixed: pinned to 0.4.0.

## Guide §16 progress

- [x] Stack research recorded with sources
- [x] CLAUDE.md ≤200 lines with the required sections
- [ ] RECONSTRUCTION.md — deferred (release clean-up), stamped after the history rewrite
- [x] `bearings.json` `scopedPaths` each hold tracked files
- [ ] `.planning/codebase/` — deferred with the map
- [x] Rules: 7 files, 0 dead globs
- [x] settings.json parses; hook suite green
- [x] `guard-push.json` protects `main`
- [x] Push guard proven on the real STATE.md (exit 2 with the blocker, 0 after `RESOLVED:`)
- [x] STATE.md, DEFERRED-BY-BLOCKER.md, agent-setup.md tracked
- [x] Docs: ARCHITECTURE.md, CONTEXT.md, ADR README + 0001, INCIDENTS.md
- [x] `verify` exists and passes
- [x] MEMORY.md created
- [ ] Owner actions listed in the final report (LSP plugins)

## Phase B gap report (top items)

| Item | State | Plan |
|---|---|---|
| CI with one required `ci-success` check | written (`ci.yml`), not yet run on GitHub | confirm green on the first PR |
| Python in CI (ruff + pytest) | written (`python` job in `ci.yml`) | same |
| Dependabot with cooldown, secret scanning | `dependabot.yml` written; secret scanning not set | scanning and push protection are GitHub settings, applied at go-live |
| Branch ruleset JSON | written (`.github/rulesets/main.json`) | applied on GitHub at go-live, after the first green run |
| Module-boundary tool | missing | ask the owner after the release (new dependency) |
| Census tests | missing | add one per incident as incidents are written |
| Test-integrity guard in CI | written (`scripts/test-integrity.sh`, `integrity` job in `ci.yml`), not yet run on GitHub | confirm on the first PR; the `test-removal-approved` label must exist on GitHub for the waiver |
| pre-commit (lint-staged + gitleaks) | missing | owner decision after the release (git hooks) |
