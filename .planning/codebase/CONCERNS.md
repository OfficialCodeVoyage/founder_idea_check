<!-- refreshed: 2026-11-12 -->
last_mapped_commit: c9be663d
# Codebase Concerns

**Analysis Date:** 2026-11-12

Scope: what is true of the code now, ranked by blast radius (what an exploit or failure reaches, then how likely it is).
The code was read at `f0160e2e`, four commits after the stamped commit (they touch the chat route's cost accounting,
`apps/chat/lib/phases/runtime.ts`, `apps/chat/lib/research/simulation.ts`, `apps/research/app/main.py` and the ADRs); the
commits after that, up to `cddf51d4`, change only comments and documents. Every claim below was checked against that tree. Where a document and the
code disagree, the code is followed and the disagreement is named. Nothing is deployed today: "deployer" means someone
who takes this repository to a public host. Items fixed on this branch are not listed as open; their residual risk is
in the last section.

## Ranked index

| # | Concern | Blast radius | Where |
|---|---|---|---|
| 1 | Authorization is checked at each call site, not in shared queries; two cross-user holes found this way (project id, document id) are fixed, more could exist | cross-tenant integrity | Security |
| 2 | Spend control is "balance above zero" plus a price table of 8 ids against ~126 listed models; any gateway model is selectable | operator's model bill | Security |
| 3 | Anonymous access: cookie-held credits, IP limit only with Redis, fails open, trusts the first `X-Forwarded-For` | operator's model bill | Security |
| 4 | Test-mode env vars switch page auth off, skip env validation and supply a published `AUTH_SECRET` fallback | whole app, needs operator error | Security |
| 5 | After-response work (extraction, gate, personas) and the stream rescue depend on the invocation surviving; no `maxDuration`; no serialisation of concurrent passes | the product's core loop | Fragile |
| 6 | Tool-input stream freeze, undiagnosed (made loud and recoverable, not fixed) | a lost document per occurrence | Known bugs |
| 7 | Deployment settings live in committed code, and docs disagree with it (`hosted`, sidecar URL, provider flags, `RESEARCH_SIDECAR_TOKEN` absent from `.env.example`) | first deploy | Tech debt |
| 8 | No index on `Message.chatId`, `Chat.userId`, `Chat.projectId`; whole-project transcript load every turn | every chat read, every turn | Performance |
| 9 | Redis connects at module load with no `error` listener | `/api/chat` availability | Fragile |
| 10 | Auth library version skew (`better-auth` 1.6.2 on `@better-auth/core` 1.5.6) | auth correctness | Dependencies |
| 11 | Research quality without SearXNG; default lanes lean on Hacker News, whose relevance test is lexical | answer quality | Scaling |
| 12 | Default balance of 50 cents has no top-up path | product stops for a real user | Missing |
| 13 | Gate calibrated on phase 1 only; missing prompts degrade to empty text; one extraction pass per turn | verdict quality | Fragile |
| 14 | Migrations skip outside Vercel; no from-zero replay in CI | schema drift | Fragile |
| 15 | Inherited privacy text; inherited dead surfaces (MCP, images, Electron, CLI templates) | public legal text, maintenance | Tech debt |
| 16 | Test gaps on every route-level authorization check | regressions in 1 to 4 | Test gaps |
| 17 | Push-guard hook gaps (`SWEEP-F1` to `SWEEP-F4`) | contributor tooling | Tech debt |

## Deployer checklist (code-level conditions, none of them is checked at build)

- Set `ai.tools.deepResearch.hosted` and `researchSidecarUrl` in `apps/chat/chat.config.ts`. They are committed as `false`
  and `http://localhost:8099`, are not environment variables, and `apps/chat/scripts/check-env.ts` accepts any non-empty URL.
- Set the same `RESEARCH_SIDECAR_TOKEN` in the app and the sidecar when they are on different hosts. Use an `https` URL: the
  token is sent as a bearer header by `apps/chat/lib/signals/sidecar.ts`.
- Turn on at least one sign-in provider: set its env pair and flip `authentication.*` in `apps/chat/chat.config.ts`. With all
  three off (the committed state) there is no sign-in outside `/api/dev-login`, which exists only when `NODE_ENV` is
  `development`.
- Set `APP_URL` outside Vercel, `REDIS_URL` only if Redis is reachable (see Fragile Areas), and `CRON_SECRET` (the
  cleanup endpoint refuses every call while it is unset).
- Never set `PLAYWRIGHT`, `PLAYWRIGHT_TEST_BASE_URL` or `CI_PLAYWRIGHT`, `RESEARCH_SIDECAR_ALLOW_UNAUTHENTICATED`, or copy
  the `RESEARCH_HOSTED: "false"` line of `docker-compose.yml`.
- Replace the page text in `apps/chat/app/privacy/page.tsx` and `apps/chat/app/terms/page.tsx` (Tech Debt).
- Use a pooled `DATABASE_URL`: `apps/chat/lib/db/client.ts` opens a default-sized `postgres` pool per process.
- There is no deployment guide and no application Dockerfile (only `apps/research/Dockerfile`); `apps/chat/vercel.json` is
  the one hosting file.

## Tech Debt

**Deployment settings in committed code, with documents that disagree (rank 7):**
- Issue: the app decides "hosted" from `ai.tools.deepResearch.hosted` in `apps/chat/chat.config.ts` (`false`), read only by
  `apps/chat/tools/platform/deep-research/deployment-mode.ts`. The env var `RESEARCH_HOSTED` is read by the sidecar
  (`apps/research/app/config.py`, default true) and has no reader in the app, although `apps/chat/lib/env-schema.ts` declares
  it and `CONTEXT.md` calls it "the deployment setting". So the two halves can disagree, and the app side defaults to the
  permissive answer. No registered source is barred in hosted mode today (`apps/research/README.md`), so nothing
  changes behaviour yet; the first source that is barred will.
- Issue: `RESEARCH_MAX_INPUT_TOKENS` (`apps/chat/lib/env-schema.ts`) and `ai.tools.deepResearch.maxInputTokensPerRun`
  (`apps/chat/chat.config.ts`, `apps/chat/lib/config-schema.ts`) have no reader; `.env.example` and the config comment say so.
  A research turn is bounded only by `maxResearcherIterations`, `maxResearcherSteps`, `maxConcurrentResearchUnits`,
  `maxSearchQueries` and the wall clock in `apps/chat/tools/platform/deep-research/research-clock.ts`.
- Issue: provider sign-in is enabled by env alone. `apps/chat/lib/auth.ts` builds `socialProviders` from `AUTH_*` and
  `VERCEL_APP_CLIENT_*` and never reads `config.authentication`; that flag only draws the buttons
  (`apps/chat/components/auth-providers.tsx`) and gates `check-env.ts`. Setting a pair makes
  `/api/auth/sign-in/social` live even with the flag off, and anyone with that provider's account can register.
- Issue: `RESEARCH_SIDECAR_TOKEN` is in `apps/chat/lib/env-schema.ts`, `turbo.json`, `README-DEV.md` and ADR-0005 but not in
  the root `.env.example`, which the file's own header says is the template to copy.
- Fix approach: read `hosted` from one place (env with the fail-closed default, as the sidecar does); add the missing
  variable to `.env.example`; delete the two unread knobs or write their reader; make `config.authentication` the
  server-side switch.

**Inherited surfaces that the config switches off but the tree still compiles (rank 15):**
- Files: MCP (`apps/chat/trpc/routers/mcp.router.ts`, `apps/chat/lib/ai/mcp/`, `apps/chat/app/api/mcp/oauth/callback/route.ts`,
  `apps/chat/components/settings/mcp-*.tsx`), image generation (`apps/chat/tools/platform/generate-image.ts`), the Electron
  login (`apps/chat/lib/electron-auth.ts`, `apps/chat/components/electron-auth-*.tsx`, `apps/chat/electron.d.ts`,
  `@better-auth/electron` in `apps/chat/package.json`), the sandbox keys in `.env.example`, `apps/chat/evals/my-eval.eval.ts`,
  the `db:branch:*` Neon scripts.
- Impact: `AGENTS.md` says to remove unused code; these are live code with their own attack surface (see Security, MCP).
  `scripts/sync-template.ts` still carries Electron handling for an `apps/electron` directory that does not exist; `packages/cli` and `packages/registry` are
  not linted or type-checked by `scripts/verify.sh` (only `packages/thread` is).
- Fix approach: delete each feature with its config flag, or move it behind a documented opt-in; extend `verify.sh` or drop
  the packages from the public repository.

**Privacy and terms pages are the ChatJS template (rank 15):**
- Files: `apps/chat/app/privacy/page.tsx`, `apps/chat/chat.config.ts` (`policies.*.lastUpdated`, `services`).
- Issue: the privacy page prints an empty list where payment processors go (`config.services.paymentProcessors` is `[]`),
  lists subscription and billing data this app never holds, and says nothing about stored project facts, demand signals or the
  model providers' handling of founder text. The "last updated" date predates this fork.
- Fix approach: write text that matches what the product stores and sends before anyone else signs in.

**Dead code:** `apps/chat/lib/db/credits.ts::_addCredits` has no caller; the `TODO` markers in `apps/chat/components/` and
`apps/chat/tools/platform/documents/create-text-document.ts` are UI polish.

**Authorization lives at call sites, not in the queries (rank 1's cause):**
- Files: `apps/chat/lib/db/queries.ts` (`getChatById`, `getProjectById`, `updateProject`, `deleteProject`, `deleteChatById`,
  `getDocumentById`, `saveDocument`, `voteMessage` all take a bare id).
- Impact: every route, tRPC procedure, server action and AI tool repeats `owner === caller`. Two incidents came from a site
  that forgot (`projectId` on `/api/chat` and the document version write, both fixed). `docs/ARCHITECTURE.md` says layer rules are "Enforced by: none".
- Fix approach: follow `getAllMessagesByProjectId`, which takes `userId` and puts it in the `WHERE`; do the same for the
  document and project writes.

## Known Bugs

**Tool-input stream freeze (rank 6, open, undiagnosed):**
- Symptoms: a tool call stays in `input-streaming` with a large partial `tool_input`, no output, no error and no `Document`;
  the turn has almost no text (`docs/INCIDENTS.md`, Incident 6; `.planning/STATE.md` lists the diagnosis as roadmap).
- Files: rescue in `apps/chat/app/(chat)/api/chat/route.ts::rescueDeadToolInputStreams` and
  `writePartialDocument`; detection and salvage in `apps/chat/lib/artifacts/text/salvage.ts`; the 32,000-token output cap read
  at `apps/chat/lib/ai/core-chat-agent.ts`.
- Trigger: not known. The cause was never captured; the cap and the rescue only bound the damage.
- What the fix does not cover: salvage writes a `Document` only for `tool-createTextDocument` for a signed-in user. A dead
  code or sheet document, a dead edit call, and any anonymous turn are marked and announced but not saved. The rescue runs in
  `onFinish`, so it assumes the invocation lives to reach it; a killed invocation leaves the original silent row
  (inferred from the code path, not observed). Nothing sweeps stale `Message.activeStreamId` values:
  `apps/chat/app/api/cron/cleanup/route.ts` only deletes orphaned attachments.
- Workaround: the failure card offers "continue from where it stopped"; no guard test exists for the cause.

**Privacy page prints empty parentheses** where processors belong (`apps/chat/app/privacy/page.tsx`).

**Server-side tRPC prefetches can still read the clock while prerendering (open, not observed):**
- Layouts and pages look the session up through `apps/chat/lib/request-session.ts::getRequestSession`, which awaits
  `connection()` first. Server-side tRPC prefetches do not: `apps/chat/trpc/init.ts::createTRPCContext` calls
  `auth.api.getSession` directly, and better-auth reads the clock. On a page whose own render runs alongside a gated
  layout (`/settings/models`, `/settings/connectors`, `/share/[id]`) that read can land in a runtime prerender stage and
  raise Next's `blocking-prerender-current-time` error. Not seen in testing.
- Deferred: both systemic fixes (`connection()` in the tRPC context, or the session lookup inside the (chat) layout's
  `Promise.all`) made the Next 16.4.5 dev server reload `/` dozens of times after sign-in. Revisit once that is understood.

## Security Considerations

**1. Cross-user writes (rank 1, both known cases fixed):**
- Fixed: a new chat could be attached to another user's project through `projectId` on `/api/chat`; it is now refused, and
  project-scoped reads filter by owner (`apps/chat/lib/db/queries.ts::getAllMessagesByProjectId`,
  `getPersonaDocumentsByProjectId`).
- Fixed: any signed-in user could append a version to another user's document by id (ids are visible in shared chats). A
  document now belongs to whoever wrote its first version (`apps/chat/lib/db/queries.ts::getOwnedDocumentById`), and
  `apps/chat/trpc/routers/document.router.ts::saveDocument`, the three edit tools and
  `apps/chat/tools/platform/read-document.ts` answer "not found" for both missing and not-yours.
- Residual: the rule is still applied query by query; a new route that reads by bare id can repeat the mistake (rank 16).

**2. Spend control and open sign-up (rank 2):**
- Risk: the pre-turn gate is `canSpend` = balance above zero (`apps/chat/lib/db/credits.ts`); the turn then runs up to five
  steps (`stepCountIs(5)` in `apps/chat/lib/ai/core-chat-agent.ts`), a 32,000-token output cap and a 50,000-token input cap
  (`apps/chat/lib/limits/tokens.ts`), and is charged afterwards. Concurrent requests all pass the check; a research turn is
  bounded only by its knobs and the 290 s clock (`apps/chat/lib/ai/request-budget.ts`). Post-turn passes are charged but
  never pre-checked (the comment in the route says so on purpose).
- Risk: `getAppModelDefinition` accepts any language model the gateway lists; only `ai.disabledModels` (empty in
  `apps/chat/chat.config.ts`) removes one, and the per-user enabled set is a UI preference. The price table
  `apps/chat/lib/ai/model-capabilities.ts::MODEL_CAPABILITIES` has 8 entries (one is an embedding model), so a signed-in caller who posts another
  `selectedModelId` runs on the operator's key and `CostAccumulator.settle()` returns it in `unpriced[]`, which is logged and
  deducted as zero.
- Risk: the title call is charged (`generateTitleFromUserMessage`, `apps/chat/app/(chat)/actions.ts`: on the turn's
  accumulator from `/api/chat`, on its own from `/api/chat/prepare`) but sends `JSON.stringify(message)` with no size
  cap. `apps/chat/app/(chat)/api/chat/prepare/route.ts` requires a 2¢ balance before the title but has no
  `MAX_INPUT_TOKENS` check, no rate limit and stores the unvalidated message body. Simulation is charged by a flat estimate
  (`apps/chat/lib/research/simulation.ts::estimateSimulationCostCents`, 0.1 cent per seat-round) because the sidecar reports no
  usage; it is reserved before the run (`reserveCredits`) and refunded only when
  `apps/chat/lib/research/simulation.ts::simulationReachedModel` is false (`apps/chat/app/actions/run-simulation.ts`):
  a kind in `SIMULATION_NEVER_STARTED_KINDS`, or a `no-reactions` run whose sidecar counted at least `seats × rounds`
  failed agent actions, i.e. every provider call failed. That run is still recorded.
- Risk: registration is open to any account of an enabled provider and there is no email or domain allow-list in
  `apps/chat/lib/auth.ts`; each account starts with `UserCredit.credits` = 50 cents (`apps/chat/lib/db/schema.ts`).
- Recommendations: restrict `selectedModelId` to `config.ai` allow-listed ids on the server; treat an unpriced model as a
  refusal for chat turns; put one atomic "reserve" on the balance before streaming; give `prepare` the same input cap and
  `canSpend` as `/api/chat`; add sign-up control (allow-list, invite or verified email).

**3. Anonymous access (rank 3, upstream behaviour kept):**
- Risk: credits live in a signed cookie (`apps/chat/lib/anonymous-session-server.ts`) with a server-side record of nothing: clearing
  the cookie, or replaying an older one, restores the default (10 in production, 1000 in development, `chat.config.ts`
  `anonymous.credits`). Client-supplied `prevMessages` feed the model on anonymous turns.
- Risk: the IP limit (`checkAnonymousRateLimit`, 5 a minute and 10 a month in production) runs only when `REDIS_URL` is set;
  without it `checkRateLimit` returns success. With Redis it fails open on any Redis error. `getClientIP` takes the first
  `X-Forwarded-For` entry, which is the caller's own value unless the proxy overwrites the header; with no header every
  request shares the `127.0.0.1` bucket. The counter is `get` then `incr`, not atomic.
- Risk: anonymous turns can still make the server fetch public URLs: file and image parts go through
  `apps/chat/lib/utils/download-assets.ts` with no cap on how many, each up to 10 MB and 15 s
  (`apps/chat/lib/utils/public-url-fetch.ts`), re-fetched every turn for the parts inside the 24,000-token context.
- Current mitigation: anonymous users get only `gpt-5.6-luna` and no tools (`ai.anonymousModels`, `anonymous.availableTools`).
- Recommendations: for a public deployment, set `anonymous.credits` to 0 or remove the path, require Redis, count on a trusted
  address (the platform's header, not the first entry), and cap URL-bearing parts per turn.

**4. Test-mode switches (rank 4):**
- Risk: any of `PLAYWRIGHT`, `CI_PLAYWRIGHT` (anything but 0, false, no, off) or a non-empty `PLAYWRIGHT_TEST_BASE_URL`
  (even the text "false") makes `apps/chat/proxy.ts` skip the session check for pages, makes `apps/chat/scripts/check-env.ts`
  skip validation, and, when `AUTH_SECRET` is unset, makes `apps/chat/lib/env-schema.ts` use a fixed string that is in this
  public repository (`DATABASE_URL` gets a local default too). That secret also signs the anonymous-session cookie. Route
  handlers and tRPC still check sessions themselves, so stored data is not opened, but anonymous credits become forgeable.
- Also: `AUTH_SECRET` is only required to be non-empty (`z.string().min(1)`).
- Recommendations: ignore the flags when `NODE_ENV` is `production`, require a minimum length, never default the secret.

**5. Residual of `/api/dev-login` (fixed on this branch):** `apps/chat/app/api/dev-login/route.ts` refuses unless
`NODE_ENV` is `development`, `Host` is loopback and `X-Forwarded-For` is loopback. Both headers can be forged, so the real
control is the `next dev --hostname localhost` bind. It mints a 30-day session for `dev@localhost`. The route also answers 404
unless `IC_DEV_SERVER_LOCALHOST_ONLY=1`, which only `apps/chat/scripts/next-dev-localhost.sh` sets, together with that bind
(it is what `dev-local.sh` and the chat `dev` / `dev:inspect` scripts run, and it refuses a hostname argument). A bare
`next dev` on a shared network lacks the marker, so forged headers no longer sign a caller in there; the residual is a server
started through that script whose bind is moved some other way, or the marker set by hand. The code comment says to re-check
after a Next.js major upgrade, because the header checks read a header Next sets from the socket.

**6. MCP outbound connections would be unguarded if enabled (latent):** `mcp.enabled` is `false`, and `assertMcpEnabled`
in `apps/chat/trpc/routers/mcp.router.ts` refuses every procedure. If a deployer turns it on, `create` accepts any `z.string().url()`
and `apps/chat/lib/ai/mcp/mcp-client.ts` connects to it directly, not through `public-url-fetch.ts`, so a user can aim the server at
internal addresses. Route it through the same address check or delete the feature.

**7. Stored files (attachments are off; residual of the owner-tag fix):**
- `apps/chat/lib/file-storage.ts::fileOwnerTag` is an unsalted SHA-256 prefix of the user id: a name, not a secret. Access still
  rests on `apps/chat/lib/file-access.ts::canReadStoredFile` and private blobs (`apps/chat/lib/storage-provider.ts`; the store
  must accept private blobs).
- The upload route (`apps/chat/app/(chat)/api/files/upload/route.ts`) trusts the client-declared MIME type, reads the whole
  form into memory first, and caps at 5 MB while the config and client say 1 MB (`attachments.maxBytes`, never read on the
  server). Serving sets `nosniff` but no `Content-Disposition` or sandbox header (`apps/chat/lib/file-content-response.ts`).
- Untagged pre-tag files are readable only through chats that referenced them before the hard-coded cutoff
  `OWNER_TAG_ROLLOUT` (2026-11-12), and the cleanup cron never deletes them (`apps/chat/app/api/cron/cleanup/route.ts`).
  A fresh database has none.

**8. No security headers:** `apps/chat/next.config.ts` and `apps/chat/vercel.json` set no CSP, frame, referrer or HSTS
headers.

**9. Sidecar (`apps/research`):** `apps/research/app/main.py::require_caller` protects `/v1/signals` and `/v1/simulate`;
`/v1/health` is open and names enabled sources, whether `GITHUB_TOKEN` is present and the caller-auth mode. With no token it
serves loopback callers only, so another process on the same host, or a same-host proxy that hides the caller's address, still
gets through (ADR-0005). `RESEARCH_SIDECAR_ALLOW_UNAUTHENTICATED` is set to `"true"` in `docker-compose.yml`. The container
listens on `0.0.0.0` inside Docker (`apps/research/Dockerfile`); the published port is `127.0.0.1` only. There is no rate
limit per caller.

**10. Session cache:** `session.cookieCache` is five minutes (`apps/chat/lib/auth.ts`), so a revoked session can still pass
for that long.

## Performance Bottlenecks

**Missing indexes (rank 8, confirmed):**
- Problem: no migration under `apps/chat/lib/db/migrations/` and no entry in `apps/chat/lib/db/schema.ts` indexes
  `Message.chatId`, `Chat.userId` or `Chat.projectId` (Postgres does not index foreign keys). Readers:
  `getAllMessagesByChatId`, `getFileReferencesByChatId`, `getAllMessagesByProjectId` (joins `Chat`),
  `getChatsByUserId` in `apps/chat/lib/db/queries.ts`.
- Fix approach: add the three indexes in a hand-checked migration (`.claude/rules/db.md`: strictly larger journal `when`,
  replay on a throwaway `pgvector/pgvector:pg17` container).

**Whole-project transcript per turn:** `apps/chat/lib/phases/runtime.ts::runPhasePass` loads every message of every chat in the
project plus all their `Part` rows (including `tool_input` and `tool_output` JSON) through
`apps/chat/lib/db/queries.ts::hydrateMessages`, twice (project and chat), then trims to 24,000 tokens in memory
(`GATE_TRANSCRIPT_BUDGET_TOKENS`). Cost grows with project age. Fix: bound the read by the budget in SQL, or keep a rolling
transcript.

**Per-turn model cost:** the judge runs on `gpt-5.6-terra` after every turn. The comment in `apps/chat/chat.config.ts`
attaches roughly $0.80 to that choice across an eight-phase project, more than the 50-cent default balance before chat
turns and research are counted.

**Connection pool:** `apps/chat/lib/db/client.ts` calls `postgres(env.DATABASE_URL)` with defaults, one pool per instance;
prepared statements are on, which a transaction-mode pooler rejects. Set `max` and `prepare` for the host.

## Fragile Areas

**After-response work and its lifetime (rank 5):**
- Files: `apps/chat/app/(chat)/api/chat/route.ts` (`after()` around `runPostTurnPhasePass` and `runPostTurnPersonaPass`),
  `apps/chat/lib/ai/request-budget.ts`, `apps/chat/vercel.json`.
- Why fragile: there is no `maxDuration` export anywhere in `apps/chat`, and the 290 s budget assumes a 300 s platform limit.
  The post-turn passes run after the response inside the same invocation (inferred); a turn that used its budget leaves them
  no time, and a killed pass writes no fail-closed row, so the gate state is just stale. Passes for one project are not
  serialised: two chats or tabs run two judges on two snapshots and `recordGateVerdict`
  (`apps/chat/lib/db/phase-queries.ts`) is last write wins, with `evaluatedAt` taken in the app, not the database.
- Safe modification: set `maxDuration` deliberately next to `CHAT_REQUEST_BUDGET_MS`; add an advisory lock or a "newer
  transcript exists" check before writing a verdict.

**Redis at module load (rank 9):** `apps/chat/app/(chat)/api/chat/route.ts` runs
`await Promise.all([publisher.connect(), subscriber.connect()])` at import when `REDIS_URL` is set, and the stream route imports
that module (`getStreamContext`). A Redis that is down at cold start fails the import, so both routes return 500. No `error`
listener is attached to either client (`git grep` finds none), and node-redis emits `error` events, so a later connection drop
can surface as an unhandled error (inferred from the library's behaviour). The anonymous limiter shares the publisher.

**Gate evidence chain (rank 13):**
- Prompts: `apps/chat/lib/phases/runtime.ts::loadPrompt` logs and returns `""` when a prompt file cannot be read. The gate then
  judges without its rubric and nothing shows. `apps/chat/next.config.ts` traces `prompts/` into the build by hand; I found no
  check that a built output contains it.
- Extraction sees only the last exchange (`lastExchange`) once per turn; a fact it misses is not revisited and drops out of the
  24,000-token judge window, so the judge can lose evidence a founder gave earlier. A failed extraction logs and continues with
  zero facts.
- Calibration: `apps/chat/evals/gate-calibration.eval.ts` runs `PHASE_ONE_FIXTURES` only (12 cases); phases 2 to 8 have no
  measured calibration. The gate model is `workflows.chat`, so a model change changes every verdict.
- Invariants hold by tests: `apps/chat/lib/phases/gate.test.ts` (fail closed), `apps/chat/lib/phases/extract.test.ts`.

**Migrations (rank 14):** `apps/chat/lib/db/migrate.ts` exits unless `VERCEL_ENV` is `production`, and `bun run build` runs it
first, so a build outside Vercel applies nothing; run `bun run db:migrate` by hand there. CHECK constraints are hand-written
(`apps/chat/lib/db/migrations/0046_*.sql`, `0051_absent_part_checks.sql`); Incident 9 records that nothing replays the chain from an
empty database and compares CHECK counts, and `.github/workflows/ci.yml` does not. A deploy's build step applies migrations
before the new code is live, so a rollback of the app meets the new schema.

**Four-place source ids and a mirrored gate:** a research source id must agree across `apps/research/app/sources/registry.py`,
`apps/research/app/config.py::KNOWN_SOURCE_IDS`, `apps/chat/lib/signals/providers.ts` and `apps/chat/lib/signals/types.ts`;
`assert_permitted` (Python) and `decideProviderGate` (TypeScript) mirror each other. No test reads both languages.
`MAX_SIMULATION_*` constants in `apps/research/app/main.py` mirror `apps/chat/lib/research/simulation.ts` by comment only.

**`apps/chat/app/(chat)/api/chat/route.ts` (1,558 lines):** one module holds request parsing, anonymous sessions, ownership checks,
streaming, the rescue, credits and the post-turn passes, with top-level `await`. Changes there are the likeliest place for a
missed ownership or charging step.

**Vendored Python files** (`apps/research/app/text/cjk.py`, `relevance.py`, `pipeline/dedupe.py`, `entity_extract.py`) are not
reformatted on purpose (`apps/research/pyproject.toml`); do not run `ruff --fix` over them.

**Version-coupled internals:** code comments rely on `ai@6.0.219` behaviour (`ToolLoopAgent` default of 20 steps,
`convertToModelMessages` dropping `input-streaming` parts, `handleUIMessageStreamFinish` calling `onFinish` once from
`flush` or `cancel`, `streamText` writing a step's `finish-step` only after its tool calls return and no `finish` part
on abort, which `apps/chat/lib/credits/main-chat-usage.ts::createMainChatUsageMeter` is built on), on `resumable-stream@2.2.10` (`createNewResumableStream`'s read loop has no catch) and on
`next@16.3.0` (`X-Forwarded-For` from the socket in `apps/chat/app/api/dev-login/route.ts`; `after()` given a promise
waits on it at once, given a callback runs it when the response closes). The turn's charge rests on the first three
(`apps/chat/app/(chat)/api/chat/route.ts::executeChatRequest` drains a tee of the chat stream). A bump of any of them needs
those rechecked.

## Scaling Limits

**Research sidecar quality and capacity (rank 11):**
- Without `RESEARCH_SEARXNG_URL`, `web-keyless` falls back to DuckDuckGo's HTML endpoint, which answers datacenter and many
  residential addresses with a challenge page; the lane then reports `blocked` and Hacker News is the only working default
  (`apps/research/README.md`, `apps/research/app/sources/web_search_keyless.py`). The browser-style user agent used for that
  endpoint (`apps/research/app/http.py::BROWSER_USER_AGENT`) is the same kind of risk the Reddit policy in
  `apps/research/app/sources/reddit_gate.py` refuses elsewhere; decide that deliberately.
- Defaults are `hackernews,web-keyless`; `arctic-shift` (Reddit archive, needs subreddits chosen) and `github` (needs
  `GITHUB_TOKEN`) are off, so a consumer-facing idea gets a developer-forum view unless the operator enables them.
- **Hacker News relevance is lexical, and for a buyer who is not a developer it still lets off-topic stories through.**
  `apps/research/app/sources/hackernews.py::matches_a_content_word` keeps a story when its TITLE shares one content word
  of the researcher's query (or two distinct weak words); the story text is not read (live re-checks 5 and 6 showed every
  text rule, even "two distinct words", admitting off-topic stories on "read" plus any other word). One generic word of a
  long query in a title is still enough: "36yo: Career at home vs. Simple life abroad?" (home), "Tailscale-rs: Official Rust
  library for embedding Tailscale" (library) and "H.R.8250 Parents Decide Act" (parent) passed a parents-of-readers question
  live. Replayed under the title-only rule, re-check 6's 20 stories become 13, and 8 of those 13 are still off topic (the 7
  dropped were 5 off topic and 2 adjacent). What bounds it today: the per-search lane limit (3 for
  a buyer who is not a developer, the rest reported as "left out", `apps/chat/lib/signals/audience.ts::NON_TECHNICAL_LANE_LIMITS`)
  and the 0.25 Hacker News audience weight (`audience.ts`), which orders the lane behind Reddit and the web. The real fix is
  semantic relevance (embedding similarity between the title and the founder's question, with a threshold). Not built; a
  word-list or stemming rule cannot tell a story's subject from a word the founder shares by luck.
- The SearXNG overlay (`docker-compose.searxng.yml`) pins no version (`searxng/searxng:latest`), is AGPL, and ships a
  placeholder `SEARXNG_SECRET` default for loopback use.
- One process, synchronous endpoints in a thread pool, a per-process `ARCTIC_SHIFT_LIMITER` (1 request a second, burst 2): more
  workers multiply the rate against a third party, and one process serialises every user's archive calls. Arctic Shift is a
  third-party service with no stated guarantee.
- Simulation needs the multi-gigabyte `simulation` image target, which pulls GPL igraph; the default container answers
  `oasis-not-installed` (`apps/research/Dockerfile`, `THIRD_PARTY-research.md`). One run can take minutes; the app waits up to
  300 s (`apps/chat/lib/research/sidecar-simulation.ts`).

**Conversation size:** chat context and the gate transcript are both 24,000 tokens regardless of the model's window;
older turns survive only as at most 66 fact rows (`apps/chat/lib/phases/runtime.ts`, `apps/chat/lib/phases/context.ts`).

**Anonymous capacity:** 10 requests per cookie in production (`apps/chat/chat.config.ts`).

## Dependencies at Risk

**`better-auth` stack skew (rank 10):** `bun.lock` resolves `better-auth` and `@better-auth/electron` to 1.6.2 while the root
`package.json` `overrides` and `apps/chat/package.json` hold `@better-auth/core` at 1.5.6; 1.6.2 declares core 1.6.2 and the
electron plugin peers on `^1.6.2`. The note beside the override (`//overrides` in `package.json`) cites a peer requirement
the lockfile no longer shows. Impact: the session, cookie and origin checks run on mixed versions. Plan: audit and remove the
override, drop `@better-auth/electron` with the Electron code.

**Python sidecar has no lockfile:** `apps/research/pyproject.toml` uses ranges (`fastapi>=0.115,<1.0`, `uvicorn[standard]`,
`pydantic`), the Dockerfile runs `pip install .`, and CI installs `-e ".[dev]"`; builds are not reproducible and carry no hashes.
`camel-oasis==0.2.5` and `mcp<2` are exact pins with a reason.

**Pinned internals:** `ai@6.0.219`, `next@16.3.0`, `resumable-stream@2.2.10`, `redis@^5.5.6`, `files-sdk@2.1.0`; see Fragile
Areas. `.github/dependabot.yml` waits seven days before proposing a bump.

**CI does not build or audit:** `.github/workflows/ci.yml` runs `verify` and `test:unit` and the sidecar's ruff and pytest; it runs
no `next build`, no end-to-end tests (needs Postgres), no migration replay, no dependency audit and no secret scan.

## Missing Critical Features

**No way to add credits (rank 12):** `UserCredit.credits` defaults to 50 cents; the only writers are `deductCredits` and the unused
`_addCredits` in `apps/chat/lib/db/credits.ts`; `apps/chat/trpc/routers/credits.router.ts` only reads. A real user who passes the
balance is refused with a 402 and only a database edit helps. There is no billing, admin tool or reset.

**No account deletion or data export:** nothing in `apps/chat/app`, `components`, `lib` or `trpc` deletes a user or exports their data,
yet the product stores founders' facts, personas and conversations.

**No deployment path for the app:** no application Dockerfile, no deploy documentation; `CLAUDE.md` records "Env deltas: None".

**No error tracking:** `apps/chat/instrumentation.ts` is a no-op by design; a deployer sees only the `pino` logs
(`apps/chat/lib/logger.ts`, redacts a short list of keys).

**Only OAuth sign-in:** `apps/chat/lib/auth.ts` configures no email or password provider and no sign-up restriction.

## Test Coverage Gaps

**Route-level authorization and charging (rank 16, priority High):**
- What is not tested: no test imports `apps/chat/app/(chat)/api/chat/route.ts` (project ownership in `handleChatValidation`,
  the anonymous credit step, `finalizeMessageAndCredits`), `apps/chat/app/(chat)/api/chat/prepare/route.ts`,
  `apps/chat/app/api/dev-login/route.ts`, `apps/chat/app/api/cron/cleanup/route.ts`, `apps/chat/lib/utils/rate-limit.ts`,
  `apps/chat/lib/anonymous-session-server.ts`, `apps/chat/lib/file-access.ts` directly, or any file under `apps/chat/trpc/routers/`.
  End-to-end specs in `apps/chat/tests/` use `/api/dev-login` for the happy path only and run locally, not in CI.
- Risk: items 1 to 4 and every "fixed" item below can regress unseen. Python covers `require_caller`
  (`apps/research/tests/test_api.py::TestCallerAuth`).

**Database behaviour:** no unit test talks to a database (`docs/DATABASE.md`); CHECK constraints and the ledger rely on schema-shape
tests and manual replay (`apps/chat/lib/db/phase-attempt.test.ts`, `fact-assertion.test.ts`). `SimulationRun.usable` null handling is
guarded by the CHECK only.

**Cross-language contract:** nothing tests that the TypeScript client and the Python sidecar agree on source ids or wire shapes
beyond each side's own tests.

**Other missing guards named in the incident log:** the `max_tokens <= 0` fallback in `apps/chat/lib/ai/core-chat-agent.ts`
(Incident 1) and the freeze itself (Incident 6).

## Recently Fixed on This Branch: Residual Risk

- **`projectId` on `/api/chat`** (`apps/chat/app/(chat)/api/chat/route.ts::handleChatValidation`, `getSystemPrompt`,
  `apps/chat/lib/db/queries.ts::getAllMessagesByProjectId`): chat rows written before the check may still name another user's
  project, so reads and writes compare owners at each use. The schema does not tie `Chat.userId` to `Project.userId`; any new
  reader of `Chat.projectId` must repeat the owner filter.
- **File access by owner tag** (`apps/chat/lib/file-access.ts`, `apps/chat/lib/file-storage.ts`, `apps/chat/lib/storage-provider.ts`):
  see Security 7. A shared chat still opens every file the owner put in that chat, by design.
- **SSRF in model-bound URL fetches** (`apps/chat/lib/utils/public-url-fetch.ts`): only this path is guarded; the MCP client and the
  sidecar adapters make their own calls (the sidecar has its own check in `apps/research/app/http.py::_is_private_http`). No limit on
  the number of URLs per turn.
- **Dev server and `/api/dev-login` on the LAN:** see Security 5; the bind is the control.
- **Sidecar caller auth** (`apps/research/app/main.py::require_caller`, ADR-0005): unset token trusts loopback callers; the compose
  dev stack deliberately turns the loopback check off; a token must reach both sides by hand.
- **Simulation and post-turn calls (formerly uncharged; fixed)** (`apps/chat/app/actions/run-simulation.ts`,
  `apps/chat/app/(chat)/api/chat/route.ts`): a simulation reserves its estimate before the run and is refunded only when
  `simulationReachedModel` is false (Security 2). The post-turn passes are charged on their own accumulator in a `finally`, after
  the turn and without a pre-check, by design. The title is charged (on the turn's accumulator, or on its own from `prepare`);
  the follow-up suggestion call and the fact-ranking query embedding are in the turn's accumulator. What remains is Security 2:
  no reserve before a chat turn, and an unpriced model is charged as zero.

## Tooling

**Push-guard hook (`.planning/DEFERRED-BY-BLOCKER.md`, open):** `SWEEP-F1` (`--dry-run` then `--no-dry-run` is treated as a dry
run), `SWEEP-F2` (aliases and a differently cased `git` are not resolved), `SWEEP-F3` (a missing hook script exits 0; accepted
design), `SWEEP-F4` (one test edit in `packages/cli/src/helpers/scaffold.test.ts` landed after the review round; to be covered by
the full-diff review). The `ask` rule on every push in `.claude/settings.json` is the human check behind the hook.

---

*Concerns audit: 2026-11-12*
