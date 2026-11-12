# Incidents

Numbered incidents. Each one ends with the guard that now makes it impossible (a test, a lint rule or a
hook), and a rule bullet in `.claude/rules/` cites the incident number where a rule file covers the code. An incident
without a guard is not closed; where a guard is missing the entry says so in as many words.

These were found in manual QA of the first end-to-end runs and in review, and they are kept without the people,
projects and database rows involved. Guard paths are relative to the repository root.

<!-- Entry shape:

## Incident N: <title> (<one-line cause>)
> **Read this first — the diagnostic tell.** <The symptom combination that identifies this incident.>

<Why the safety nets didn't catch it. First seen: YYYY-MM, how it was found.>

### Symptoms
### Diagnosis        (numbered steps, the decisive check first)
### Resolution
### Prevention       (the guard: test / lint rule / hook path; plus the rule bullet citing "Incident N")
-->

## Incident 1: A zero stood in for "unknown" (a placeholder number that means something else)
> **Read this first — the diagnostic tell.** A number that looks fine (0, `$0.00`, `{}`, "0 sources") sits where the
> truth is "never reported" or "never ran", and the feature behind it silently does nothing.

Provider model lists report an id, an owner and a creation time, and no context window, output limit or price. The
OpenAI gateway adapter wrote `context_window: 0`, `max_tokens: 0` and `pricing: {}` for every model it listed (the
other gateways still do for a model the capability table does not cover), and `0` is a valid number, so no type, lint
rule or test with a hand-built model objected. First seen: 2026-08, as three separate failures that shared one cause.

### Symptoms
- Deep research failed with `Invalid prompt: messages must not be empty`: a context budget of zero tokens made
  `truncateMessages` discard every message.
- A founder's credit balance never moved: the cost accumulator skipped every model that had no price, so every
  turn was settled as zero cost and the out-of-credits refusal could never fire.
- A turn failed outright on a model the capability table did not cover: the output cap was
  `min(configured, max_tokens)`, and `max_tokens` was 0.
- Neighbouring cases of the same shape: a simulation run in which every agent call failed was stored and badged as
  "collapsed" (identical to personas that all agreed); an unread credit balance printed as `$0.00`; a failed judge
  call's empty `perCriterion` was presented as "1 thing is missing"; a research run that never started was reported as
  "0 seconds, 0 searches, 0 sources".

### Diagnosis
1. Find the zero or the empty value in the failing path and ask who reported it. If the provider never does, it is a
   placeholder.
2. Search for `?? 0`, `|| 0` and `{}` defaults applied to values that come from outside.
3. Check that the unknown has its own arm in the type, with no number to read.

### Resolution
Each unknown got its own arm. `lib/ai/model-capabilities.ts` is a static table (no runtime fetch) whose lookups return
a union with an unknown arm that carries no value. `CostAccumulator.settle()` returns `unpriced[]` beside `cents`,
so a call that could not be priced is named, not skipped. `lib/ai/core-chat-agent.ts` treats `max_tokens <= 0` as
unknown and leaves the configured cap in force. `getModelContextWindow` (`tools/platform/deep-research/utils.ts`)
treats a non-positive window as unreported and falls back to a conservative floor, and `truncateMessages` never
returns an empty list for a non-empty one. `judgeSimulation` returns `SimulationNotAssessed`, which has no `usable`
field; `SimulationRun.usable` is nullable, and the CHECK `SimulationRun_assessment_coherent` ties a null `usable` to a
recorded reason. `formatCreditBalance` renders an unread balance as an em dash.

### Prevention
Guards: `apps/chat/lib/ai/model-capabilities.test.ts`, `apps/chat/lib/ai/token-utils.test.ts`,
`apps/chat/lib/credits/cost-accumulator.test.ts` (`settle()` names what it could not price),
`apps/chat/lib/credits/format-credit-balance.test.ts`, `apps/chat/lib/research/simulation.test.ts` and
`apps/chat/lib/phases/rail.test.ts` (a fail-closed BLOCK is not a gap list). **No automatic guard** for the
non-positive `max_tokens` fallback in `core-chat-agent.ts`: `apps/chat/chat.config.test.ts` pins only the shape of
the reader. Rule: `.claude/rules/env-config.md`.

## Incident 2: The gate kept refusing a founder who had no evidence yet (it asked for values that only fieldwork can produce)
> **Read this first — the diagnostic tell.** The same phase BLOCKs turn after turn, the next question asks for numbers
> or scores that only offline work (interviews, observation) could produce, and an honest founder refuses to invent
> them.

Every rule of `decideGate` was correct and tested. The failure was a sequence of refusals no single call shows, and
the text of the next question had been treated as prompt quality rather than as an invariant. First seen: 2026-08, the
first real founder session in manual QA, after seven refusals.

### Symptoms
- A phase whose criterion needs field data ("four evidence-backed rubric scores") BLOCKs on every turn.
- The next question is "what scores do X, Y and Z receive?". A founder who has run no interviews can only fabricate
  an answer or stay blocked. If they had typed four numbers, the phase would probably have passed, which inverts the
  purpose of the gate.

### Diagnosis
1. Open the phase's refusal history (the ledger, ADR-0004) and read the sequence of `nextQuestion` values.
2. Check whether the open criteria are ones only offline work can close. Criteria carry `closure`:
   `in-conversation` or `offline-only`.

### Resolution
When every open blocking criterion is `offline-only`, the verdict is still BLOCK, but the obstacle is
`fieldwork-required` and the next question asks for the instrument and the collection plan (the protocol, the
pre-registered thresholds), never for the values. A criterion the founder can answer now is always asked first. A
founder who has done the fieldwork can enter the result as a founder-asserted fact (ADR-0003). Nothing about this
advances a phase.

### Prevention
Guard: `apps/chat/lib/phases/gate.test.ts`, the block "decideGate — a gap that needs fieldwork" (it still BLOCKs, it
refuses to re-ask for the scores and asks for the instrument, a closure classification never reaches PASS). Rule:
`.claude/rules/phases-gate.md`.

## Incident 3: One judge label decided how many gaps the gate reported (the headline moved while the findings did not)
> **Read this first — the diagnostic tell.** A series of BLOCKs whose headline count jumps (1 of 8, then 5 of 8, then
> 1 again) while the stored per-criterion results show the same criteria unmet each time.

`decideGate` returns on the first matching rule, and the not-evaluable rule sat above the unmet rule. One criterion
changing label between "not-evaluable" and "unmet" therefore changed which group decided the verdict, and the headline
named only that group. A reader took it for criteria closing and re-opening; nothing had moved. First seen: 2026-08, in
manual QA, read off the refusal ledger.

### Symptoms
- The rail and the verdict card oscillate between a short and a long list of gaps on a static transcript.
- Replaying the stored verdicts shows the same unmet criteria on every attempt.

### Diagnosis
1. Read every stored verdict for the phase from `ProjectPhaseAttempt`, not the one on screen.
2. Count the blocking criteria that are not met per attempt (not-evaluable, unmet and partial together). If that count
   is steady while the headline moves, this is the incident.

### Resolution
Every BLOCK branch reports the whole open set, ordered by the phase definition (not by severity, which would reorder
with the label), and the reason says how many more are still open beyond what decided. The next question is chosen
over the whole open set.

### Prevention
Guard: `apps/chat/lib/phases/gate.test.ts`, the block "decideGate — the headline may not move on one label" (the same
open set whichever label the judge picked, an unmet criterion never hidden behind a not-evaluable one). Rule:
`.claude/rules/phases-gate.md`.

## Incident 4: Every gate verdict overwrote the one before it (the refusals were not kept)
> **Read this first — the diagnostic tell.** A phase's attempt counter is higher than the number of stored verdicts,
> and the history cannot show a refusal the founder remembers.

`ProjectPhase` has one row per phase and the writer updated it in place, so each verdict destroyed the previous one.
The row was correct at every instant; only history was lost, and no test read history. First seen: 2026-08, in a full
walkthrough of the eight phases.

### Symptoms
- `attemptCount` exceeds the number of rows in the ledger for the phase, and the numbering of stored attempts does not
  start at 1.
- A refusal seen ten minutes earlier could not be recovered.

### Diagnosis
Compare `ProjectPhase.attemptCount` with `count(*)` in `ProjectPhaseAttempt` for the project and phase. Attempts that
predate the ledger left only their counter behind and cannot be recovered.

### Resolution
An append-only ledger keyed by `(projectId, phaseKey, evaluatedAt)`, written in the same transaction as the phase row.
The key is the clock, not the attempt number, because a mutable counter that fell behind would make every later insert
a primary-key violation and freeze a stale PASS. The history screen says "Showing N of M attempts" when it is shorter
than the counter. See ADR-0004.

### Prevention
Guards: `apps/chat/lib/db/phase-attempt.test.ts` (keys on the clock, no uniqueness on `(projectId, phaseKey)`, cannot
store a verdict without its rationale, cascades from the project) and `apps/chat/lib/phases/attempt-history.test.ts`.
Rule: `.claude/rules/db.md`.

## Incident 5: A founder's assertion could be passed as extracted evidence (the provenance marker never reached the judge)
> **Read this first — the diagnostic tell.** In a judge or extractor prompt, a fact the founder typed reads exactly like
> one the extractor quoted from the conversation; or a later extraction silently replaces a founder's correction.

When founders became able to correct and add facts, `ProjectFact.origin` was added, and the renderer annotated founder
facts. The function that mapped stored rows into the judge's input listed fields by name and dropped `origin`, so the
annotation could never fire. Tests of the renderer passed, because they handed it `origin` directly. First seen:
2026-08, during review of the QA fixes.

### Symptoms
- The judge's prompt has no "asserted by the founder, not extracted" text, whatever the stored `origin` is.
- Exported documents show a founder-typed value as if it had been extracted.

### Diagnosis
1. Read the prompt the judge and the extractor are actually given for a project that holds a founder-origin fact.
2. Follow the field from the row to the prompt through every mapping function.

### Resolution
`origin` crosses every mapping (`runPostTurnPhasePass`, `toExportFacts`), `reconcileFacts` skips founder facts before
the confidence comparison, and the export carries the marker. See ADR-0003.

### Prevention
Guards: `apps/chat/lib/phases/runtime.test.ts` ("provenance reaches the models": judge and extractor),
`apps/chat/lib/phases/extract.test.ts` (a founder's correction is never overwritten),
`apps/chat/lib/phases/gate.test.ts` (`renderFacts` marks founder facts),
`apps/chat/lib/db/fact-assertion.test.ts`, and the CHECK `ProjectFact_origin_coherent`. Rule:
`.claude/rules/phases-gate.md`.

## Incident 6: A document stream died mid-way and nothing said so (a tool call frozen in `input-streaming`)
> **Read this first — the diagnostic tell.** A tool call that stays in `input-streaming` forever: a spinner, a
> half-rendered document, no error, no stored document, and an assistant turn with almost no text.

The tool's input stopped arriving partway through a long document. `input-streaming` is then an accurate state, so no
transition failed and nothing threw, and the UI could not tell a call whose input was still arriving from one whose
input never would. There was also no output ceiling in the app, so output length was a provider default that nothing
checked. What stopped the stream was never explained. First seen: 2026-08, reported by the founder, who had to notice
the missing content and name the line where it stopped.

### Symptoms
- A `Part` row with `tool_state = 'input-streaming'`, a large `tool_input`, empty `tool_output`, null `tool_errorText`,
  and no matching `Document`.
- The copy button on the report had nothing to copy (Incident 8).

### Diagnosis
1. Look for tool parts still in `input-streaming` on a message whose stream has ended.
2. The stored input is whatever arrived before the stream stopped, usually a partly parsed `{ title, content }`. If it
   already holds a title and a body, the document is salvageable.

### Resolution
At the end of a stream, `rescueDeadToolInputStreams` in the chat route writes a salvaged prefix as a `Document`
labelled partial (title, top and bottom of the body), rewrites the call to `output-error` carrying a marker (which also
lets the model see its own failure on the next turn), and appends text saying what was lost, how much survived and the
line it stopped after. The text claims "saved" only for a document the route actually wrote. The UI shows a failure
card with actions to open what was saved (or the unsaved copy) and to continue from where it stopped.
`config.ai.maxOutputTokens` (32,000) is read in one place, `lib/ai/core-chat-agent.ts`, and clamped by the model's own
ceiling.

### Prevention
Guards: `apps/chat/lib/artifacts/text/salvage.test.ts` (detect, salvage, mark, and "says saved only for a call the
route wrote a document for") and `apps/chat/chat.config.test.ts` (the output cap survives config parsing and has a
reader). **No automatic guard** for the cause, which is unexplained; if it recurs, capture it in the act. Rule:
`.claude/rules/env-config.md` (the `maxOutputTokens` bullet).

## Incident 7: Deep research reported a search that never ran (no sources, and no reason given)
> **Read this first — the diagnostic tell.** "Researched for 0 seconds, 0 searches, 0 sources", zero citations, an error
> quoting an SDK internal, and a model that had just promised a source-cited study.

Several things failed at once. The context budget was zero (Incident 1), which emptied the prompt. The error text
blamed a tool that had in fact been called. Four of six source lanes were switched off, and the structured refusals the
sidecar returned never reached the founder, who learned it by asking why only one source appeared. The pieces of the
refusal machinery were unit-tested, and the zeros were valid numbers. First seen: 2026-08, manual QA.

### Symptoms
- A research block that finishes with zero sources and an error the founder cannot act on.
- The model apologising and asking the founder for "a bit of scope", which could not help.
- A research report that quietly leaned on one lane (Hacker News) without saying the others were off.

### Diagnosis
1. `GET /v1/health` on the sidecar: which sources are `operator_enabled`, and which ids are unknown.
2. Read the per-lane report in the research output: it names every source and whether it ran, found nothing, or was
   refused, with the refusal text verbatim.

### Resolution
A preflight (`decideResearchAvailability`) reads the same gate decision one step earlier, before the tool is described
to the model, so a deployment that cannot research says so. A per-lane report names every source and what it did, with
four arms (returned with a count, found nothing, refused, not attempted) and no count on the last two. An all-refused
or all-blocked harvest is an error, not an empty result. `describeResearchRun` returns a union whose not-searched arm
carries no count, so a run that never started cannot print "0 sources". The report-outcome message says the tool was
called when it was. The tool's description states its contract to the model (it takes no arguments; the conversation
is its subject), so the model stops asking the founder for a prompt.

### Prevention
Guards, all in `apps/chat/tools/platform/deep-research/` unless a path says otherwise: `research-availability.test.ts`,
`lane-report.test.ts`, `report-outcome.test.ts` and `sidecar-search.test.ts` (a fully blocked harvest fails closed, and
a lane report names every source), `apps/chat/components/research-run-summary.test.ts` (a run that never started has
no count to print), and `apps/chat/lib/ai/token-utils.test.ts` for the emptied prompt.

## Incident 8: The copy button said "Copied" after copying nothing
> **Read this first — the diagnostic tell.** A success toast for a clipboard action that put nothing on the clipboard.

The artifact copy action called `navigator.clipboard.writeText(content)` without awaiting it, checked nothing, and
fired the success toast unconditionally; with an empty document (Incident 6) it wrote an empty string. The helper it
was meant to match swallowed the rejection too: the clipboard hook catches the error and returns `false`, and the
caller ignored the boolean. No test touched the clipboard. First seen: 2026-08, reported by the founder.

### Symptoms
- "Copied to clipboard!" and an empty paste.
- With clipboard permission denied in the browser, the same toast.

### Diagnosis
Call the action with empty content, and with the browser's clipboard permission denied. The toast should name the
failure.

### Resolution
`lib/artifacts/copy-to-clipboard.ts::copyArtifactToClipboard` refuses empty or whitespace-only content, awaits the
write, and returns a union whose failed arm carries a reason and no character count. The artifact actions and the
message actions toast that outcome.

### Prevention
Guard: `apps/chat/lib/artifacts/copy-to-clipboard.test.ts`.

## Incident 9: The migration chain built a schema with seven CHECK constraints missing
> **Read this first — the diagnostic tell.** A database built from the migration files has fewer CHECK constraints than
> `schema.ts` declares, while every migration applied without error.

The maintainers' database was built with `drizzle-kit push`, so every constraint it had came from `push`, and nobody
had ever replayed the chain from an empty database. `0044` recorded the seven `Part` constraints in its snapshot and
emitted no SQL, so every later `generate` diffed against a snapshot that already claimed them. First seen: 2026-08,
the first from-zero replay.

### Symptoms
- On a chain-built database, `Part` rows storable that the app assumes cannot exist: a text part with no text, a tool
  part with no call id, a file part with no URL.
- `push` was permanently noisy (`Suggestion`'s foreign key name is 64 characters and Postgres truncates at 63), so a
  difference between the push-built and chain-built schemas carried no signal.

### Diagnosis
1. Replay the chain on a throwaway `pgvector/pgvector:pg17` container.
2. Count CHECK constraints in `pg_constraint` and compare with the `check(` calls in `schema.ts`.
3. Compare `pg_get_constraintdef` for each against a database you trust.

### Resolution
`0051_absent_part_checks.sql` adds the seven constraints, hand-written, guarded with `IF NOT EXISTS` lookups in `DO`
blocks because a push-built database already has them, with the expressions copied from drizzle-kit's own `push`
output. See `docs/DATABASE.md`.

### Prevention
Rule: `.claude/rules/db.md` ("CHECK constraints are written by hand"; replay a new migration on a throwaway
container). **No automatic guard:** nothing runs the chain against an empty database in CI. A check that does,
and compares the CHECK count with `schema.ts`, would close this incident.

## Incident 10: turbo's strict env mode dropped `RESEARCH_ENABLED_SOURCES` (a variable in the schema but not in `turbo.json`)
> **Read this first — the diagnostic tell.** A research source works under `bun run dev:local` and is refused under
> `bun run dev`, with the reason "not enabled for this deployment" and a variable that is plainly set in `.env.local`.

`bun run dev` goes through turbo, which runs in strict env mode and passes a task only the variables listed in
`globalEnv` in `turbo.json`. Five keys of `serverEnvSchema` (`RESEARCH_ENABLED_SOURCES`, `LITELLM_BASE_URL`,
`LITELLM_API_KEY`, `VERCEL_SANDBOX_RUNTIME_PYTHON`, `VERCEL_SANDBOX_RUNTIME_JAVASCRIPT`) were missing from that list. The
app fell back to its two keyless defaults, and an operator who had switched a source on saw it refused with no hint that
the variable never arrived. `dev:local` bypasses turbo, which is why the gap stayed invisible there. First seen: 2026-11,
while verifying a research source.

### Symptoms
- Different behaviour between `bun run dev` and `bun run dev:local` with the same `.env.local`.
- A variable defined in `.env.local` reads as unset in the app.

### Diagnosis
Compare the variable against `globalEnv` in `turbo.json`. Then start the app through `dev:local`: if the behaviour
changes, turbo dropped it.

### Resolution
The missing keys were added to `globalEnv`, together with the test and debug switches the app reads at runtime.

### Prevention
Guard: `apps/chat/lib/env-schema.test.ts`, a census: every key of `serverEnvSchema` must appear in `globalEnv`. It
fails on the old `turbo.json` and passes on the current one. Rule: `.claude/rules/env-config.md`.
