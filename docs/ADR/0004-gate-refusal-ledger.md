# ADR-0004 — Keep every gate verdict, in an append-only ledger keyed by time

## Status
Accepted — 2026-11-12. Enforced by: `apps/chat/lib/db/phase-attempt.test.ts` (the key, the absence of a uniqueness
rule on `(projectId, phaseKey)`, the cascade) and the primary key of `ProjectPhaseAttempt`. This records a decision
taken when the first full walkthrough of the eight phases showed what was being lost.

## Context
`ProjectPhase` holds one row per `(projectId, phaseKey)`, and the writer overwrote `decision`, `reason`,
`nextQuestion` and `verdict` on every gate run. Each verdict destroyed the one before it. In this product the refusals
are the product: a founder refused three times and then passed has a record of what they had to establish. The
overwrite also made the app hard to debug, because a walkthrough could not recover a refusal it had watched happen ten
minutes earlier.

## Decision
We will append one `ProjectPhaseAttempt` row per gate run and never update or prune it.

- **The primary key is `(projectId, phaseKey, evaluatedAt)`, not the attempt number.** The number is a display label
  copied from `ProjectPhase.attemptCount`, a mutable counter on an updated row. A counter that fell behind its own
  maximum (a restore, a manual repair, a push that recreated the table) would make the next insert raise a primary-key
  violation, roll back the transaction it shares with the phase row, and collide the same way on every later turn: a
  permanent write outage for the phase, and a stale PASS the gate could never replace. A clock cannot do that.
  `Document` versions on `(id, createdAt)` for the same reason.
- `ProjectPhase` stays one row per phase so the hot read never scans history. It is not a projection of the ledger.
- A verdict is stored as the gate wrote it (`json`, parsed on read, never cast), with its decision and reason, so a
  verdict cannot be stored without its rationale.
- The ledger cascades from `Project`, so deleting a project erases it.
- The history screen says when it shows fewer verdicts than the counter records ("Showing 3 of 4 attempts"), because
  an attempt that predates the ledger left only its counter behind.

## Consequences
- Retention is unbounded: a verdict is 6 to 8 KB, so a realistic project stays well under 200 KB.
- The founder's words quoted in `verdict.perCriterion[].evidence` now outlive the message they quote. Editing or
  regenerating a message deletes later messages, but not the verdicts that quoted them. No new data category and no
  author field are added, and erasure still works through the cascade; what changes is that deleting a message no
  longer eventually purges text quoted in a verdict.
- The migration that created the table backfilled one row from each existing phase row that had a decision. That
  recovers the last verdict only. Earlier refusals were already gone, and phases with no decision were skipped rather
  than invented, because "never assessed" must not become a verdict.
- The ledger feeds the refusal history, the attempt number on the verdict card, and the count of how often a
  criterion has blocked.
