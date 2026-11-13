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

### SWEEP-F5 — Anonymous chat spend is bounded only by a cookie and an optional rate limit
**Raised:** 2026-11-12, `release/public-prep-261112`, pre-release security review (upstream behaviour). **Status:** OPEN
Anonymous credits live in a signed cookie, so clearing it resets them. The IP rate limit
(`apps/chat/lib/utils/rate-limit.ts::checkRateLimit`) applies only when Redis is configured, fails open on Redis errors,
and `getClientIP` trusts the first `X-Forwarded-For` value, which can be forged when not behind Vercel. Matters only
for an internet-facing deployment with anonymous chat on (`apps/chat/chat.config.ts`).
**Clearing condition:** a deployer-facing decision: turn anonymous chat off by default for deployments, or bind the
limit to a trusted client address and a server-side counter.

### SWEEP-F6 — Test-mode environment variables switch page auth off
**Raised:** 2026-11-12, same review (upstream behaviour). **Status:** OPEN
Setting `PLAYWRIGHT`, `PLAYWRIGHT_TEST_BASE_URL` or `CI_PLAYWRIGHT` (`apps/chat/lib/playwright-test-environment.ts`)
changes how `apps/chat/app/(chat)/layout.tsx` obtains the session and relaxes required variables in
`apps/chat/lib/env-schema.ts`, including a published `AUTH_SECRET` fallback. Needs operator error to matter; listed in the
deployer checklist of `.planning/codebase/CONCERNS.md`.
**Clearing condition:** refuse those variables when `NODE_ENV` is `production`.

### SWEEP-F7 — Most selectable models have no price, so their calls are logged but not charged
**Raised:** 2026-11-12, same review. **Status:** OPEN
The price table covers the configured workflow models; any other gateway model a user selects is logged as unpriced
and not deducted. Per-turn spend stays gated by `canSpend`.
**Clearing condition:** restrict selectable models to priced ones, or refuse an unpriced model.

### SWEEP-F8 — Post-turn work assumes the request survives
**Raised:** 2026-11-12, codebase concerns map. **Status:** OPEN
Extraction, the gate run, persona regeneration and the stream rescue run in `after()` / `onFinish` in
`apps/chat/app/(chat)/api/chat/route.ts`; no `maxDuration` is set and concurrent passes for one project are not
serialised. A killed invocation silently skips them.
**Clearing condition:** a durable job (queue or workflow) for post-turn passes, with one pass per project at a time.

### SWEEP-F9 — No indexes on the hottest chat lookups
**Raised:** 2026-11-12, codebase concerns map. **Status:** OPEN
`Message.chatId`, `Chat.userId` and `Chat.projectId` have no index, and every project turn loads the whole project
transcript (`apps/chat/lib/db/queries.ts::getAllMessagesByProjectId`). Fine at one founder's scale.
**Clearing condition:** a hand-written migration adding the indexes (`.claude/rules/db.md`), measured first.

### SWEEP-F10 — The Redis client has no error listener
**Raised:** 2026-11-12, codebase concerns map (upstream behaviour). **Status:** OPEN
The client connects at module load with no `error` handler, so an unreachable `REDIS_URL` can take `/api/chat` down.
**Clearing condition:** add an error listener and treat Redis as optional at runtime, as the rate limit already does.

### SWEEP-F11 — Migrations skip outside Vercel and nothing replays them from zero
**Raised:** 2026-11-12, codebase concerns map. **Status:** OPEN
The migrator skips itself unless `VERCEL_ENV` is set (`bun run db:migrate` forces it), and no test or CI job replays
the chain on an empty database (`.claude/rules/db.md`).
**Clearing condition:** a CI job that migrates an empty pgvector database from zero.

### SWEEP-F12 — The research sidecar's HTTP client follows redirects without re-checking them
**Raised:** 2026-11-12, same review. **Status:** OPEN (low)
`apps/research/app/http.py` uses `urllib`, which follows redirects without re-checking https or private addresses and
reads bodies without a size limit. Only fixed source hosts are called, so the impact is low.
**Clearing condition:** disable automatic redirects (or re-check each hop) and cap the body size.

### SWEEP-F13 — resumable-stream's background promise never settles when Redis or the chat stream fails
**Raised:** 2026-11-12, review of `executeChatRequest`'s resumable-stream fallback (pre-existing, upstream library);
widened the same day after a second review. **Status:** OPEN (low)
`resumable-stream@2.2.10` `createNewResumableStream` registers `ctx.waitUntil(new Promise(...))` whose resolver
(`streamDoneResolver`) runs only in its read loop's `done` branch, after the sentinel `set`, the `unsubscribe` and the
done `publish`es all succeed. Every other way out leaves the promise unsettled, and `waitUntil` is `after`, so on
Vercel each holds the invocation open until its time limit (locally nothing is held):
- `subscriber.subscribe` rejects: `makeStream` never runs and the read loop never starts. The route then serves the
  stream plain and charges it (`apps/chat/app/(chat)/api/chat/route.ts::executeChatRequest`).
- `reader.read()` rejects, which is what the chat stream does when it errors partway (the SDK's message processor
  rejects a malformed chunk): `reader.read().then(async …)` has no rejection handler, so the rejection is unhandled
  (Next logs it) and, from the source, the response's controller is neither errored nor closed, so a client reading
  through Redis is left waiting instead of getting the error.
- A chunk `publish` to a resuming listener rejects: the async `then` callback rejects unhandled and the loop stops.
- The `done` branch's `set` / `unsubscribe` / `publish` rejects: the same unhandled rejection, and the resolver is
  never reached.
The turn's charge does not depend on any of these: the route drains its own tee of the stream.
**Clearing condition:** fixed upstream (settle the promise and error or close the controller on every exit of
`subscribe` and of the read loop, and handle the read and publish rejections), or the route wraps resumable-stream so
that what it hands `waitUntil` is bounded by the chat stream's own end and every rejection in the read loop is caught.
Check all four paths above, not only the subscribe one.

### SWEEP-F25 — The "Answering:" label shows for a criterion the prompt did not use
**Raised:** 2026-11-13, `feat/gate-criterion-target-prompt-261113`, `/code-review` (high), final round (the round cap applied).
**Status:** OPEN (low)
`components/user-message.tsx::TargetNote` labels any stored criterion id, but `lib/phases/runtime.ts::resolveTarget` honours only an id of the current phase. If the phase advances in `after()` while a target from the old phase is armed, the message shows "Answering: X" although the interviewer never saw it.
**Clearing condition:** the label is seen on a message whose target was dropped, or the bubble learns which phase the message was sent in.

### SWEEP-F26 — The double-send guard works around the store's lagging status instead of fixing it
**Raised:** 2026-11-13, `feat/gate-criterion-target-prompt-261113`, `/code-review` (high), final round (the round cap applied).
**Status:** OPEN (low)
`lib/send-draft-chat-submission.ts` keeps a module-level send-flight registry because `lib/stores/base/use-chat.ts` mirrors the chat status into the store through an effect plus `requestAnimationFrame`. Every sender has to opt in (`useSendFlight`); a new sender that does not can double-send.
**Clearing condition:** the store sets `submitted` synchronously in a store-level `sendMessage`, and the registry is removed.

### SWEEP-F27 — The prompt can repeat the fieldwork rule two or three times
**Raised:** 2026-11-13, `feat/gate-criterion-target-prompt-261113`, `/code-review` (high), final round (the round cap applied).
**Status:** OPEN (low)
For an offline-only criterion target, `lib/phases/directive.ts::targetLines` and `fieldworkPlanLines` both say never to ask for or accept an on-the-spot number, and under a `fieldwork-required` obstacle `FIELDWORK_INSTRUCTION` says it too. Costs prompt tokens and gives the model overlapping instructions.
**Clearing condition:** one paragraph carries the rule when more than one would render.

### SWEEP-F28 — Code comments and the prompt use words the glossary rules out for a criterion target
**Raised:** 2026-11-13, `feat/gate-criterion-target-prompt-261113`, `/code-review` (high), final round (the round cap applied).
**Status:** OPEN (low)
`CONTEXT.md` says a criterion target is not a "mark" or a "claim", yet `lib/db/schema.ts`, migration `0054`, `docs/DATABASE.md` call it "a claim about intent" and the prompt in `lib/phases/directive.ts::targetLines` says the founder "marked" the message.
**Clearing condition:** the wording is made consistent (the prompt sentence changes only with a paid check of the reply).

### SWEEP-F29 — The criterion-target id shape is written out by hand in several places
**Raised:** 2026-11-13, `feat/gate-criterion-target-prompt-261113`, `/code-review` (high), final round (the round cap applied).
**Status:** OPEN (low)
`lib/ai/types.ts` (`TARGET_CRITERION_ID_PATTERN` plus a redundant `.max()`), the CHECK in `lib/db/schema.ts`, migration `0054` and `docs/DATABASE.md` each repeat `^[a-z0-9-]{1,64}$`. Widening one without the others makes `chatMessageToDbMessage` accept a value the CHECK refuses, which fails the whole save.
**Clearing condition:** the schema CHECK is derived from the constant, or the shape changes and all copies move together.

### SWEEP-F30 — Every chat event re-renders all checklist rows
**Raised:** 2026-11-13, `feat/gate-criterion-target-prompt-261113`, `/code-review` (high), final round (the round cap applied).
**Status:** OPEN (low)
`components/phase/gate-verdict-card.tsx::useCriterionActions` subscribes `ChecklistBody` to the last message id and the chat status, which it needs only at click time, and returns a new actions object each render, so each send step re-renders the 8 to 10 rows.
**Clearing condition:** a measured slowdown, or the handler reads the last message id from the store at click time and the actions are memoised.

<!-- Entry shape:
### SWEEP-F1 — <one-line title>
**Raised:** YYYY-MM-DD, <branch / context>. **Status:** OPEN
<facts, risk, `file::symbol`>
**Clearing condition:** <what resolves it>
-->

**Closed**
