# ADR-0003 — Every fact records who asserted it, and a founder cannot raise a fact's confidence

## Status
Accepted — 2026-11-12. Enforced by: the CHECK `ProjectFact_origin_coherent`, and the tests
`apps/chat/lib/db/fact-assertion.test.ts`, `apps/chat/lib/phases/extract.test.ts` (a founder's correction is never
overwritten), `apps/chat/lib/phases/gate.test.ts` (`renderFacts` marks founder facts) and
`apps/chat/lib/phases/runtime.test.ts` (provenance reaches the judge and the extractor). This records a decision
taken when founders were first allowed to edit facts.

## Context
The gate reads the fact store, and the persona, the simulation and the export are all grounded in it. For a while every
fact was written by the extractor, so "where did this claim come from" needed no column. Then a founder who had run
interviews offline had nowhere to put the answer except pasting field notes into chat and hoping the extractor read
them, and a founder who disagreed with an extracted fact had no way to fix it. An edit button is also a way for a
founder to launder an assumption into evidence and then pass their own gate on it, which is the failure this product
exists to prevent.

## Decision
We will let a founder correct a fact's value, delete a fact, and assert a new one, and we will mark every such fact as
the founder's, all the way to the models and the export.

- `ProjectFact.origin` is `extracted` or `founder`, and `correctedAt` is set exactly when it is `founder` (a CHECK
  enforces it). Provenance is never inferred from `sourceMessageId IS NULL`.
- A founder cannot change a fact's key (it is half of the `(projectId, key)` identity) or its confidence. A founder
  assertion gets a fixed confidence, the extractor's own noise floor (`MIN_FACT_CONFIDENCE`, 40), read from no request
  field. The key of a new assertion must be one the current phase's extractor could write.
- The extractor never overwrites a founder's fact, checked before the confidence comparison, because a
  high-confidence extraction is exactly the case that would otherwise win.
- `renderFacts` marks a founder fact ("asserted by the founder, not extracted") in the judge's prompt and in the
  extractor's, which decides what to overwrite. The exported repository carries the marker too (`FOUNDER-ASSERTED`,
  an `Origin` column in `FACTS.md`), and a founder fact is never banded as low confidence, because its number is not
  the extractor's.
- Nothing here advances a phase. The gate still judges and still refuses.

## Consequences
- A marker that never reaches the judge is decoration. It once did not: the mapper between fact rows and the judge
  dropped `origin`. The test that pins the marker runs from the row mapper to the prompt (Incident 5 in
  `docs/INCIDENTS.md`).
- Correcting a value clears the fact's embedding so retrieval does not keep steering by the old wording
  (ADR-0002).
- A founder-asserted fact is weaker evidence by construction: it is attributable to a person who chose it, not to an
  observation. The judge may weigh it as such.
- Making confidence founder-editable would make a shipped document lie, and it is the one dial that would let someone
  raise their own evidence. That door stays shut.
