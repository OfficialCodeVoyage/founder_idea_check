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

### SWEEP-F14 — The chat model list can differ between the server render and the first client render
**Raised:** 2026-11-13, `fix/next-16-4-render-errors-261112`, `/code-review` (high) of the Next 16.4 render fixes.
**Status:** OPEN (low, not observed)
`apps/chat/providers/chat-models-provider.tsx::ChatModelsProvider` builds `models` (the enabled set every model picker
reads) from `settings.getModelPreferences`, which the (chat) layout prefetches without awaiting. The server and the
browser can each see that query pending or resolved on the first render, so the enabled set, and any markup built from
it, could differ and fail hydration: the same cause as the `/settings/models` row-order mismatch, which this branch fixed
in `apps/chat/components/settings/models-table.tsx::ModelsTable` by rendering server-read preferences. No mismatch on `/`
in six clean-restart loads after sign-in on Next 16.4.5 (checked by hand).
**Clearing condition:** a hydration error from a model picker is seen, or the provider is given the server-read
preferences (as the models page does) so that both sides render from the same data.

### SWEEP-F15 — The models settings page can show cached switch states up to a minute old after a client-side navigation
**Raised:** 2026-11-13, `fix/next-16-4-render-errors-261112`, `/code-review` (high) of the Next 16.4 render fixes.
**Status:** OPEN (low, not observed)
`app/(chat)/settings/models/page.tsx` reads the preferences on the server and hands them to
`components/settings/models-table.tsx::ModelsTable`, which fixes the row order from that fresh read but takes the switch
states from the query cache first. The page no longer dehydrates the cache, so after a soft navigation within the
query's 60-second `staleTime`, a change made in another tab or device shows in the order but not yet in the switches.
**Clearing condition:** the switches are seen disagreeing with the saved state, or the page writes its server read into
the cache when it is newer than the cached copy.

### SWEEP-F16 — A model toggle cancels an in-flight preferences fetch, including a refresh the user started
**Raised:** 2026-11-13, `fix/next-16-4-render-errors-261112`, `/code-review` (high), final round (the round cap applied).
**Status:** OPEN (low)
`components/settings/models-table.tsx::ModelsTable` awaits `cancelQueries` on the shared `getModelPreferences` key before its optimistic write (the documented TanStack pattern). A refresh the user clicked just before toggling, or the hydrated first fetch `ChatModelsProvider` waits on, is cancelled; the post-settle refetch restores the data, with no message about the dropped refresh.
**Clearing condition:** a lost refresh is seen, or the toggle stops cancelling fetches it did not start.

### SWEEP-F17 — The lint rule for the request-time barrier misses several ways to bypass it
**Raised:** 2026-11-13, `fix/next-16-4-render-errors-261112`, `/code-review` (high), final round (the round cap applied).
**Status:** OPEN (low)
`apps/chat/biome.jsonc` restricts `getQueryClient` from `trpc/server` outside `lib/request-session.ts` and the (chat) layout. It cannot see a new `getQueryClient()` inside the allowed layout, `getRequestQueryClient()` placed inside a `Promise.all`, or a server component reaching tRPC through the exported `trpc` proxy or `HydrateClient`; any of these can bring back `blocking-prerender-current-time`.
**Clearing condition:** a structural check (ast-grep in `verify`) covers these, or the tRPC context gets a barrier that does not loop the dev server.

### SWEEP-F18 — Each request looks the session up twice
**Raised:** 2026-11-13, `fix/next-16-4-render-errors-261112`, `/code-review` (high), final round (the round cap applied).
**Status:** OPEN (low)
`lib/request-session.ts::getRequestSession` and `trpc/init.ts::createTRPCContext` each call better-auth's `getSession`; with a stale cookie cache that is two session reads per (chat) render. Both ways of sharing one lookup made the Next 16.4.5 dev server reload pages in a loop (`.planning/codebase/CONCERNS.md`).
**Clearing condition:** a shared lookup is found that loads each page once on a clean dev restart.

### SWEEP-F19 — Pages that only need the session also load the tRPC router
**Raised:** 2026-11-13, `fix/next-16-4-render-errors-261112`, `/code-review` (high), final round (the round cap applied).
**Status:** OPEN (low)
`lib/request-session.ts` imports `getQueryClient` from `@/trpc/server` for `getRequestQueryClient`, so the login, device-login and project screens pull the router graph into their server bundles. Its two other homes looped the dev server (71 and 51 reloads of `/`).
**Clearing condition:** a home for `getRequestQueryClient` outside this module loads each page once on a clean dev restart.

### SWEEP-F20 — The models page passes the request-time barrier twice
**Raised:** 2026-11-13, `fix/next-16-4-render-errors-261112`, `/code-review` (high), final round (the round cap applied).
**Status:** OPEN (low)
`app/(chat)/settings/models/page.tsx::readInitialPreferences` awaits `getRequestSession()` (to skip the protected read for signed-out visitors) and then `getRequestQueryClient()`, so `connection()` is awaited twice. Harmless (it is idempotent); a simplification only.
**Clearing condition:** the page is next edited.

### SWEEP-F21 — Billing and agent comments cite ai@6.0.219 behaviour that was not re-checked on 6.0.323
**Raised:** 2026-11-13, `fix/dependabot-minor-patch-261112`, code review of the AI SDK 6.0.323 bump. **Status:** OPEN (low)
Comments in `apps/chat/lib/credits/main-chat-usage.ts`, `apps/chat/app/(chat)/api/chat/route.ts`,
`apps/chat/lib/ai/followup-suggestions.ts`, `apps/chat/chat.config.ts`, `apps/chat/lib/config-schema.ts` and
`apps/chat/tools/platform/deep-research/researcher-agent.ts` give the reason for a charge or a limit as `ai@6.0.219`
behaviour (when a stop is charged and in what order the abort reaches the stream, `ToolLoopAgent`'s default step count,
`convertToModelMessages` part handling). The bump to 6.0.323 did not re-check any of them.
**Clearing condition:** re-run each cited mock-model check on 6.0.323 (the stop-and-charge ordering in
`main-chat-usage.ts` and the route first), then correct the comment or the code and update the version the comment cites.

### SWEEP-F22 — A reload after a stream ended gets its finished message as one transient data part, not as a UI-message stream
**Raised:** 2026-11-13, `fix/dependabot-minor-patch-261112`, code review of the AI SDK 6.0.323 bump. **Status:** OPEN (low)
`apps/chat/app/(chat)/api/chat/[id]/stream/route.ts::appendMessageResponse` answers a reload after the stream already
ended with a one-shot stream that carries only a transient `data-appendMessage` part, no `start`, parts or `finish`;
`hooks/use-complete-data-part.ts` puts the real message into the chat. Since `ai` 6.0.323 rebuilds a resumed response
from empty state, the SDK finishes that resume with a part-less assistant message under a fresh id, which
`onFinish` would add to the tree and the cached list. The mitigation today is the guard at the top of `onFinish` in
`apps/chat/components/chat-sync.tsx` (a part-less assistant message the chat never held is dropped). A `start` chunk
alone does not replace it: the SDK would write a part-less copy over the stored message and finish with it under the real id.
**Clearing condition:** the route replays the finished message as a real UI-message stream (`start` with the stored id,
its parts, `finish`), so the SDK rebuilds it like any replay; then remove the guard.

### SWEEP-F23 — The root `.env.example` does not name the Vercel Blob variables
**Raised:** 2026-11-13, `fix/files-sdk-3-261112`, `/code-review` (high) of the files-sdk 3 update.
**Status:** OPEN (low)
This branch adds `BLOB_READ_WRITE_TOKEN` and `BLOB_STORE_ID` to `apps/chat/lib/env-schema.ts` and `BLOB_STORE_ID` to `turbo.json`, and check-env names both options, but the root `.env.example` has no Blob entry (`.claude/rules/env-config.md` wants one in the same change). Agents cannot edit that file; the owner adds the lines from the pull request description.
**Clearing condition:** the root `.env.example` lists both options.

### SWEEP-F24 — No test guards the rule that a file read is never redirected to a provider link
**Raised:** 2026-11-13, `fix/files-sdk-3-261112`, `/code-review` (high) of the files-sdk 3 update.
**Status:** OPEN (low)
`lib/file-content-response.ts` now always streams an access-checked file and never answers 307 to a presigned URL; the existing tests use the memory store, which cannot sign, so re-adding a redirect would pass CI. Not added under the owner's no-new-tests rule.
**Clearing condition:** the owner asks for the test, or a redirect is reintroduced.

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
