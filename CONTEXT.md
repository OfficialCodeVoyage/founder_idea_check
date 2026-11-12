# Domain glossary

Use these words in code, UI and docs. Definitions come from the code named in each row.

| Term | Meaning | Not to be confused with / forbidden synonyms |
|---|---|---|
| Project | One idea a founder is validating; owns its chats, facts, phases and tasks (`Project` table). | not "workspace", not "idea" in code |
| Phase | One of `PHASE_COUNT` (8) ordered validation stages with its own prompt, fact keys and exit criteria (`lib/phases/types.ts::PhaseDefinitionSchema`). | not "step" (steps are inside the AI agent loop) |
| Exit criterion | A typed condition a phase must meet before it advances: `artifact-exists`, `requirement-satisfied` or `metric-threshold`. | not "requirement" alone, not "check" |
| Severity | `blocking` (unmet ⇒ BLOCK) or `advisory` (unmet ⇒ WARN only). | not "priority" |
| Closure | How a criterion can be closed: `in-conversation` (founder can answer now) or `offline-only` (needs fieldwork). | not severity |
| Criterion status | The judge's label per criterion: `met`, `partial`, `unmet`, `not-evaluable` (could not tell; never treated as met). | "not-evaluable" is not "unmet" |
| Judge | The LLM call that labels each criterion with evidence, gap and next question (`JudgeOutputSchema`). | the judge does not decide; the gate does |
| Gate | Code that turns the judge's labels into a verdict and fails closed (`lib/phases/gate.ts::decideGate`). | not "validator", not "check" |
| Verdict | `PASS`, `WARN` or `BLOCK`, plus the missing items, the next question and the rule that fired (`GateVerdictSchema`). | not "score", not "result" |
| Obstacle | What stands in the way of a non-PASS verdict, as data: `evidence-missing`, `fieldwork-required`, `not-evaluable`, `no-facts-yet`, `judge-incomplete`, `phase-misconfigured`, `advisory-only`. | not the same as the missing list |
| Attempt | One stored gate run for a phase, kept as the refusal ledger (`ProjectPhaseAttempt`). | `ProjectPhase` is current state, not history |
| Fact | A `key = value` the project has established, with a 0–100 confidence (`ProjectFact`). Keys are snake_case and belong to exactly one phase. | not "memory", not "note" |
| Origin | Who asserted a fact: `extracted` (by the extractor) or `founder` (typed or corrected by hand). | not the source of a signal |
| Extraction | The post-turn LLM pass that proposes facts from the conversation, with a quote as evidence (`lib/phases/extract.ts`). | not research |
| Unblocking task | A founder to-do derived from a BLOCK verdict, id `phaseKey::criterionId::kind` (`ProjectTask`, `lib/ultraplan/`). | not a chat "task" from ChatJS |
| Persona | An evidence-backed description of a target customer; every attribute carries a source (`lib/personas/types.ts`). | never an invented customer |
| Simulation | Synthetic persona reactions to a pitch (OASIS in the sidecar). A hypothesis generator; `usableAsEvidence` is always false. | never "validation", never "evidence" |
| Demand signal | One public item showing someone has the problem: title, url, snippet, date, engagement, relevance; no author (`DemandSignal`). | not a "lead", not a "review" |
| Source | A sidecar adapter that fetches signals, with a stable id (`hackernews`, `github`, `arctic-shift`…). | not a citation |
| Lane | One source's stream of signals as shown, weighted and ordered in a research report (`lib/signals/audience.ts`). | not a phase |
| Sidecar | The Python service in `apps/research` the chat app calls over HTTP for signals and simulation. | not "backend" |
| Hosted mode | The deployment setting (`RESEARCH_HOSTED`, default true) under which risky sources are barred. | not "production" |
| Deep research | The multi-step web research tool inherited from ChatJS (`tools/platform/deep-research/`). | not the signal harvest |
| Handoff | The exported project folder (PRD, planning, persona files, `CLAUDE.md`) built by `lib/export/handoff.ts`. | not a "report" |
| Credits | Spend per user in cents (`UserCredit.credits`), settled per turn by `lib/credits/`. | not tokens |
