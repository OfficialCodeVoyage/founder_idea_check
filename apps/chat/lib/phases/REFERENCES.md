# Phase-gate references

Shapes borrowed for the gate decision and the exit-criteria vocabulary. **No
file from either project was copied into this repo** — only the shape and one
guard were taken, and both are reimplemented here in Zod against our own types.
Recorded anyway so the origin of the design is not lost, and so the row in
`THIRD_PARTY.md` has something to point at.

Both sources are MIT, and this file quotes short passages of each verbatim (a
type, a guard, a test, JSON schema excerpts), so their notices travel with it:

- warden: Copyright (c) 2026 Warden contributors. Full text:
  `LICENSES/MIT-QuintinBotes-warden.txt`.
- devs: Copyright (c) 2025 CODENAME SAS. Full text:
  `LICENSES/MIT-codename-co-devs.txt`.

Both licences were read from the upstream repositories, not inferred from a badge.

---

## 1. Gate decision shape — `QuintinBotes/warden`

| | |
|---|---|
| Repo | https://github.com/QuintinBotes/warden |
| Licence | MIT (`LICENSE`, "Copyright (c) 2026 Warden contributors") |
| Repo HEAD when read | `2736c2b35e6db8a9031a0a1aa7a6c247970bfe19` (2026-07-10, release 0.4.1 "Fail Closed"). **That id no longer exists upstream**: the repository was created on 2026-10-05 and carries the same releases and commit messages under different commit ids. The same release is tag `v0.4.1` = `f9906253d0096b7687b86b5497a0848602f22003` (2026-07-10); every passage quoted below was re-checked against it on 2026-11-12. |
| Files read | `packages/orchestrator/src/evaluate-exit-criteria.ts`, `packages/orchestrator/src/evaluate-exit-criteria.test.ts`, `packages/core/src/change-surface.ts` |
| Guard introduced in | `2ea95c2a99926c88f4319ac75e2180a122060366` (was recorded here as `d469abff00cc18aa68bcad005ddf9989c5e62227`, which no longer resolves) — *"fix(gate): never emit a false-green when nothing ran, passed, or was gated (#60)"* |

### The decision type

`packages/core/src/change-surface.ts`, verbatim:

```ts
export interface GateDecision {
  decision: 'PASS' | 'WARN' | 'BLOCK';
  reason: string;
  // ── Enterprise gate-override trail (additive; all optional, so every existing reader is
  //    unaffected — a self-hosted decision simply never sets these). ──────────────────────
  overridden?: boolean;
  overriddenBy?: string; // Principal.subject
  overrideReason?: string;
}
```

Two required fields only: a three-valued verdict and a **human-readable reason
that names the rule that fired**. The reason is not decoration — it is the
product. A gate that says "BLOCK" without naming the gap is useless to a founder.

The `overridden*` fields are warden's enterprise escape hatch (a privileged human
comments on a PR to force a merge). We do not need them for the vertical slice,
but the *pattern* is worth keeping in mind: the override is recorded **on the
decision**, so an overridden BLOCK is still visibly a BLOCK, with an audit trail
attached — it is never rewritten into a PASS.

### The empty-set guard — the whole reason we read this file

`packages/orchestrator/src/evaluate-exit-criteria.ts`, verbatim:

```ts
  const total = results.length;

  // No results is not a pass — the pass-rate math below would otherwise manufacture 100% for
  // an empty set (0/0). "No tests ran" surfaces the anomaly without hard-blocking.
  if (total === 0) {
    return { decision: 'WARN', reason: 'no tests ran' };
  }
```

And the vestigial line it defends, four lines further down, **still in the file**:

```ts
  const passRate = total === 0 ? 1 : passCount / total;
```

That ternary *was* the bug. Before commit `2ea95c2a`, `total === 0` fell through
to `passRate = 1` → `100%` → clears every threshold → confident green `PASS` on a
run where nothing was evaluated. The upstream commit message states it plainly:

> `evaluateExitCriteria([])` → `WARN "no tests ran"` (the pass-rate short-circuit
> (`total === 0 ? 1 : …`) previously manufactured a 100% pass rate for 0/0).

The `total === 0 ? 1 :` branch is now dead code — unreachable behind the guard.
Left in place upstream; **do not reproduce it.** Compute the ratio only on the
non-empty path.

Its test, verbatim:

```ts
  it('WARNs on an empty result set — no tests ran is not a pass', () => {
    const decision = evaluateExitCriteria([], cfg);
    expect(decision.decision).toBe('WARN');
    expect(decision.reason).toMatch(/no tests ran/i);
  });
```

### Rule order — most-severe-first, guard above everything

The function is a flat sequence of early returns. Order is the logic; there is no
scoring, no weighting, no aggregation:

| # | Condition | Verdict |
|---|---|---|
| 0 | `total === 0` | `WARN` — "no tests ran" |
| 1 | `p1Fails > 0 && cfg.gates.blockOnCritical` | `BLOCK` |
| 2 | `p2Fails > cfg.gates.warnOnHighCount` | `BLOCK` |
| 3 | `passRatePercent < cfg.gates.blockOnPassRateBelowPercent` | `BLOCK` |
| 4 | `p2Fails > 0` | `WARN` |
| 5 | fallthrough | `PASS` — "All exit criteria met: N/M passed." |

Three properties worth stealing:

1. **The "cannot evaluate" guard sits above the severity ladder**, not inside it.
   Absence of evidence is its own branch, decided before any threshold is
   consulted. It is not modelled as a low score.
2. **Every non-PASS return carries an interpolated reason naming the specific
   failing thing** (`${p1Fails} critical (P1) test failure(s)`, `pass rate
   ${passRatePercent.toFixed(1)}% is below the required ${…}%`). The reason is
   built at the point of decision, where the numbers are in scope — never
   reconstructed later from the verdict.
3. **`WARN` is a real third state**, not a soft BLOCK. It means "advance is
   permitted but something is off", which is exactly the register we want for a
   founder who is *nearly* through a phase.

### Where we should deliberately diverge

Warden chose **WARN-direction** for the empty set at library level, because in
its world the dangerous action (merging) is guarded elsewhere and a hard block on
a legitimate no-test change would be obnoxious. In the same release it made the
opposite choice at the boundary that actually gates the merge — commit
`f90fc357743e5038567d7e95ce14fd984ab587ff` (recorded here as `222e7d870aad…`
before upstream's commit ids changed), *"fix(action): fail closed when the
gate can't be evaluated (#61)"*:

> `normalizeGate` coerced a missing or unrecognized gate decision to PASS
> (`String(g.decision ?? 'PASS')`) → now only an explicit, recognized
> PASS/WARN/BLOCK is trusted; anything else fails closed to BLOCK.

**For us, phase advance *is* the merge.** There is no second gate downstream. So
a phase with zero exit criteria, or an unparseable judge response, should fail
closed to `BLOCK`, not `WARN`. Take warden's guard placement and its "0/0 is not
100%" rule; take the Action's fail-closed direction rather than the library's.
Never let an unrecognised or absent verdict default to PASS.

### Not taken

`evaluateExitCriteria` itself. It is priority-bucket arithmetic over
`{status, priority}[]` test rows against numeric thresholds — a different problem
from an LLM judging a transcript against prose criteria. The 3★ repo is also
built for a CI orchestrator we are not running. Shape and guard only.

---

## 2. Exit-criteria vocabulary — `codename-co/devs`

| | |
|---|---|
| Repo | https://github.com/codename-co/devs |
| Licence | MIT (`LICENSE`, "Copyright (c) 2025 CODENAME SAS" — MIT body verbatim, no title line) |
| Repo HEAD when read | `ce05b2c3dce2665e00942c540406a8bf78b39a13` |
| File last changed at | `fa3bc4758147395545f37f77c666af2c25c4fa82` (2025-10-19, ":wrench: Tweaks") |
| Files read | `public/schemas/methodology.schema.json`, `src/types/methodology.types.ts`, `public/methodologies/5-whys.methodology.yaml` |

### The `Criterion` type enum

`public/schemas/methodology.schema.json`, `$defs.Criterion`, verbatim:

```json
    "Criterion": {
      "type": "object",
      "description": "A condition that must be satisfied",
      "required": ["type"],
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "artifact-exists",
            "requirement-satisfied",
            "metric-threshold",
            "phase-completed",
            "custom"
          ],
          "description": "Type of criterion"
        },
        "description": {
          "type": "string"
        },
        "artifactType": {
          "type": "string",
          "description": "Required artifact type ID (for artifact-exists)"
        },
        "requirementId": {
          "type": "string",
          "description": "Requirement ID (for requirement-satisfied)"
        },
        "metric": {
          "type": "string",
          "description": "Metric name (for metric-threshold)"
        },
        "threshold": {
          "type": "number",
          "description": "Threshold value"
        },
        "operator": {
          "type": "string",
          "enum": ["<", "≤", ">", "≥", "==", "!="],
          "description": "Comparison operator"
        },
        "phaseId": {
          "type": "string",
          "description": "Phase ID (for phase-completed)"
        },
        "customValidator": {
          "type": "string",
          "description": "Custom validation function reference"
        }
      }
    },
```

The same enum appears in their generated TS as `CriterionType`, and it matches
the schema exactly:

```ts
export type CriterionType =
  | 'artifact-exists'
  | 'requirement-satisfied'
  | 'metric-threshold'
  | 'phase-completed'
  | 'custom'
```

`Criterion` is used for **four** things in their model, not just exit criteria —
`Phase.entryCriteria`, `Phase.exitCriteria`, `Loop.convergenceCriteria` /
`Loop.exitConditions`, and `Branch.condition`. One vocabulary, four positions.

`exitCriteria` hangs off the phase and is explicitly the gate:

```json
        "exitCriteria": {
          "type": "array",
          "description": "Conditions that must be met before phase completes (quality gate)",
          "items": {
            "$ref": "#/$defs/Criterion"
          }
        },
```

### The flaw to fix on the way in

`required: ["type"]` — **every discriminating field is optional.** A
`metric-threshold` criterion with no `metric`, no `threshold` and no `operator`
validates cleanly. So does an `artifact-exists` with no `artifactType`. The JSON
Schema documents the correlation in prose ("for artifact-exists") and enforces
none of it; the TS mirror has the same hole.

Type this as a **discriminated union on `type`** in Zod, so each variant requires
its own fields. That is the one substantive improvement to make while borrowing.

Note also that `description` is optional. For an LLM-judged gate it is the field
the judge actually reads — make it required for us.

### `qualityGates`

`configuration.qualityGates`, verbatim:

```json
        "qualityGates": {
          "type": "object",
          "description": "Global quality gate settings",
          "properties": {
            "enabled": {
              "type": "boolean",
              "default": true
            },
            "autoRetry": {
              "type": "boolean",
              "description": "Automatically retry failed phases"
            },
            "maxRetries": {
              "type": "integer",
              "minimum": 0,
              "default": 2
            }
          }
        },
```

Its TS mirror, verbatim:

```ts
export interface QualityGateConfiguration {
  enabled?: boolean
  autoRetry?: boolean
  maxRetries?: number
}
```

Three fields, all optional. `enabled` defaults **true** — gates are on unless
switched off. `maxRetries` allows `0` (`minimum: 0`) and defaults to `2`, so
"retry twice then stop" is the out-of-box posture. `autoRetry` has no default,
which is the schema saying "the host decides".

**Placement matters:** `qualityGates` sits under top-level `configuration`, i.e.
it is **methodology-global**, while `exitCriteria` is **per-phase**. Retry policy
is one setting for the whole run; the criteria vary per phase. If we want a
per-phase retry budget we are extending their model, not copying it — say so in
the schema comment when we do.

### Real usage

From `public/methodologies/5-whys.methodology.yaml` — the vocabulary in anger,
showing the global/per-phase split and `phase-completed` used as an entry
criterion to chain phases in order:

```yaml
configuration:
  qualityGates:
    enabled: true
    autoRetry: true
    maxRetries: 2

phases:
  - id: define-problem
    name: Define the Problem
    order: 0
    exitCriteria:
      - type: artifact-exists
        description: Problem statement must be defined
        artifactType: problem-statement

  - id: ask-why-1
    name: Ask Why #1
    order: 1
    entryCriteria:
      - type: phase-completed
        description: Define the Problem phase must be completed
        phaseId: define-problem
    exitCriteria:
      - type: artifact-exists
        description: First why must be answered
        artifactType: why-1-answer
```

Across all 41 of their methodology YAMLs the criteria are overwhelmingly
`artifact-exists` and `phase-completed` — the two mechanical ones. That is a
signal, not an accident: those are the two a machine can check without judgement.
`requirement-satisfied` and `custom` are where an LLM judge would have to live.

### Health warning: their TS has drifted from their schema

`src/types/methodology.types.ts` claims to be "generated from
methodology.schema.json" but is stale. The schema has enum members the TS lacks:

- `ExecutionStrategy` — TS is missing `parallel-sequential`, `event-driven`, `event-driven-sequential`
- `FailureStrategy` — TS is missing `retry-with-escalation`, `graceful-degradation`, `continue-on-error`
- `TaskType` — TS is missing `communication`, `coordination`
- `ArtifactFormat` — TS is missing `text`
- `MethodologyMetadata` — TS omits the schema's `i18n.origin`

**The two things we are taking are the two that agree**: `CriterionType` and
`QualityGateConfiguration` are identical in both. Treat the JSON Schema as the
source of truth for anything else, and re-check rather than trusting the TS.

### Not taken

The rest of the schema — 700-odd lines of agent roles, ceremonies, artifact
dependency graphs, communication patterns, Mermaid diagram strings. That is a
generic swarm-orchestration model for arbitrary business methodologies. We want
five string literals and a three-field retry config.
