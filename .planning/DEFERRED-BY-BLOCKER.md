# Deferred by blocker
Findings a review gate surfaced that were real but out of scope for the diff under review. Registered so the next
reviewer does not re-find them. Open entries first; closed ones collapse to one line under **Closed**.

Number entries `SWEEP-F1`, `SWEEP-F2`, and so on. Never reuse a number.

## Section F — review-gate deferrals

### SWEEP-F1 — Push guard treats `--dry-run --no-dry-run` as a dry run
**Raised:** 2026-11-12, `chore/agent-setup-261112`, automated security review of the installed hook kit. **Status:** OPEN
`.claude/hooks/require-pr-on-blocker.sh` sets its dry-run flag on `--dry-run` (or a short-flag cluster
containing `n`) and never clears it, while git lets a later `--no-dry-run` win. A command carrying both
is skipped by the guard and still pushes. Risk is low: the guard is a speed bump for honest mistakes,
and the `ask` rule on every push in `.claude/settings.json` is the human check behind it. The script is
a byte-identical copy of a shared, tested kit, so it is not patched here.
**Clearing condition:** fixed in the kit's home (process the flags in order, or count an unrecognised
`--no-*` option as unprovable), its test suite extended, and the script re-copied into this repo.

### SWEEP-F2 — Push guard does not resolve git aliases or a differently-cased `git`
**Raised:** 2026-11-12, same review. **Status:** OPEN
The guard matches the literal words `git … push`. An alias that expands to push, or `GIT push` on a
case-insensitive filesystem, is not seen. The kit documents aliases as a known gap of text parsing.
Same mitigation as SWEEP-F1.
**Clearing condition:** the kit resolves `alias.*` from git config and matches the command name
case-insensitively, with tests; then re-copy.

### SWEEP-F3 — Hook launchers resolve the script from the git top level and exit 0 when it is missing
**Raised:** 2026-11-12, same review. **Status:** OPEN (accepted design)
`.claude/settings.json` runs each hook through `git rev-parse --show-toplevel` rather than
`$CLAUDE_PROJECT_DIR`, and a missing script exits 0. Both are deliberate: the top level is the checkout
the session is actually in (a worktree keeps its own hooks), and with `onFailure: block` a missing
script would otherwise block every shell command on a branch that predates the hooks. The cost is that
the guard is absent, not failing closed, on such a branch.
**Clearing condition:** none planned; revisit if the guard is ever relied on as a security boundary.

### SWEEP-F4 — One test edit landed after the QA-batch review round
**Raised:** 2026-11-12, `release/public-prep-261112`, review gate at the private-backup push. **Status:** OPEN
`packages/cli/src/helpers/scaffold.test.ts` changed after the `/code-review` round over the QA batch: one expected
value moved from `bun@1.3.1` to `bun@1.3.14` to follow the root `packageManager` pin. Test-only, no runtime code.
**Clearing condition:** covered by the `/code-review` round over the full release diff before the public push.

<!-- Entry shape:
### SWEEP-F1 — <one-line title>
**Raised:** YYYY-MM-DD, <branch / context>. **Status:** OPEN
<facts, risk, `file::symbol`>
**Clearing condition:** <what resolves it>
-->

**Closed**
