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
- **Phase definitions are pinned by `lib/phases/definitions.test.ts`:** exactly `PHASE_COUNT` (8) phases ordered
  1..8; fact keys disjoint across phases (`UNIQUE (projectId, key)`); every criterion `factKey`/`metric` belongs
  to its phase's `factKeys`; no `phase-completed` or `custom` criteria; at least one blocking criterion per phase.
- **No intake/brainstorm phase.** `definitions.ts` explains why phase 1 opens instead; idea finding for a market
  is planned as a stage before a project exists, not as a phase.
- **Extraction never overwrites a founder's fact.** `extract.ts::reconcileFacts` skips keys whose stored
  `origin` is `founder`; a founder assertion gets the fixed `MIN_FACT_CONFIDENCE` (40), never a typed value.
  Guards: `lib/phases/extract.test.ts`, `lib/db/fact-assertion.test.ts`.
- **The gate runs in `after()` and must be awaited there** (`app/(chat)/api/chat/route.ts`, phase pass then
  persona pass). Turn N's verdict reaches turn N+1's system prompt, not turn N.
- **Prompt files are read from disk at request time.** `next.config.ts` traces `./prompts/**/*`; a prompt outside
  that folder is missing in a deployed build.
- **`bun run eval:gate` spends money** (about 24 judge calls on the chat model). Run it only when asked.
- Gate or phase change → update `apps/chat/lib/phases/REFERENCES.md` if a borrowed idea changes.
