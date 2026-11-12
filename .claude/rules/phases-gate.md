---
paths:
  - "apps/chat/lib/phases/**"
  - "apps/chat/prompts/**"
  - "apps/chat/app/actions/correct-fact.ts"
  - "apps/chat/evals/**"
---
# Phase engine and gate — landmines

- **The gate fails closed.** In `lib/phases/gate.ts::decideGate` every rule returns early, and the only PASS
  without evidence is an explicit `gate.enabled === false`. A judge error or a malformed judge reply becomes a
  BLOCK (`failClosedVerdict`). `not-evaluable` is never treated as met. Guard: `lib/phases/gate.test.ts`.
- **A blocking criterion at `partial` BLOCKS** (`tolerateBlockingPartials` defaults to 0). Raising it needs a
  per-phase reason, and it can only ever yield WARN.
- **Every BLOCK branch reports the whole open set**, ordered by the phase definition, never only the group that
  decided (Incident 3). Which judge label a criterion got must not change how many gaps the founder is told about.
  Guard: `lib/phases/gate.test.ts` ("the headline may not move on one label").
- **A gap that only fieldwork can close is never asked for as a value** (Incident 2). Each criterion has a `closure`
  (`in-conversation` or `offline-only`); when every open blocking criterion is `offline-only` the obstacle is
  `fieldwork-required` and the next question asks for the instrument, not the data. A closure never reaches PASS.
  Guard: `lib/phases/gate.test.ts` ("a gap that needs fieldwork"), `definitions.test.ts` (every criterion states one).
- **Phase definitions are pinned by `lib/phases/definitions.test.ts`:** exactly `PHASE_COUNT` (8) phases ordered
  1..8; fact keys disjoint across phases (`UNIQUE (projectId, key)`); every criterion `factKey`/`metric` belongs
  to its phase's `factKeys`; no `phase-completed` or `custom` criteria; at least one blocking criterion per phase.
- **No intake/brainstorm phase.** `definitions.ts` explains why phase 1 opens instead; idea finding for a market
  is planned as a stage before a project exists, not as a phase.
- **Extraction never overwrites a founder's fact.** `extract.ts::reconcileFacts` skips keys whose stored
  `origin` is `founder`; a founder assertion gets the fixed `MIN_FACT_CONFIDENCE` (40), never a typed value (ADR-0003).
  Guards: `lib/phases/extract.test.ts`, `lib/db/fact-assertion.test.ts`.
- **`origin` must survive every mapping from a fact row to a model prompt** (Incident 5): `runPostTurnPhasePass`
  feeds the judge and the extractor, `toExportFacts` feeds the export. A marker the judge never receives is
  decoration. Guards: `lib/phases/runtime.test.ts` ("provenance reaches the models"), `gate.test.ts`.
- **Every gate run is appended to `ProjectPhaseAttempt`** and never overwrites the last verdict (ADR-0004,
  Incident 4). Guard: `lib/db/phase-attempt.test.ts`.
- **The gate runs in `after()` and must be awaited there** (`app/(chat)/api/chat/route.ts`, phase pass then
  persona pass). Turn N's verdict reaches turn N+1's system prompt, not turn N.
- **Prompt files are read from disk at request time.** `next.config.ts` traces `./prompts/**/*`; a prompt outside
  that folder is missing in a deployed build.
- **`bun run eval:gate` spends money** (about 24 judge calls on the chat model). Run it only when asked.
- Gate or phase change → update `apps/chat/lib/phases/REFERENCES.md` if a borrowed idea changes.
