<!-- refreshed: 2026-11-12 -->
last_mapped_commit: c9be663d
# External Integrations

**Analysis Date:** 2026-11-12

Variable NAMES only; no value is recorded here. The one list of app server variables is `apps/chat/lib/env-schema.ts`; the
tracked template is the repo-root `.env.example`; the real values live in the repo-root `.env.local` (gitignored, never opened).
Sidecar variables are read in `apps/research/app/config.py` and `apps/research/app/simulation/oasis_runner.py`.

## APIs & External Services

**Model provider (chat, judge, extraction, research, titles):**
- OpenAI - the selected gateway (`ai.gateway: "openai"` in `apps/chat/chat.config.ts`; `DEFAULT_GATEWAY` in
  `apps/chat/lib/ai/gateways/registry.ts`).
  - SDK/Client: `@ai-sdk/openai` through `apps/chat/lib/ai/gateways/openai-gateway.ts`
  - Auth: `OPENAI_API_KEY` (read straight from `process.env`, not through `lib/env`, so scripts and tests can load the registry)
  - Model list: `GET https://api.openai.com/v1/models`, revalidated hourly; with no key a static fallback table is used
    (`apps/chat/lib/ai/gateways/fallback-models.ts`). Context windows and prices come from `apps/chat/lib/ai/model-capabilities.ts`
    because the endpoint reports neither.
  - Model ids per workflow: `apps/chat/chat.config.ts` (`gpt-5.6-terra` for chat and the gate judge, `gpt-5.6-luna` for titles,
    extraction and the research loop). Ids are typed per gateway, so changing the gateway means changing them too.
  - Cost: each turn is settled in cents by `apps/chat/lib/credits/`, against `UserCredit.credits` (`apps/chat/lib/db/credits.ts`).
- OpenAI embeddings - `text-embedding-3-small`, 1536 dimensions, via `apps/chat/lib/embeddings/provider.ts`; uses `OPENAI_API_KEY`.
  With no key `getEmbeddingProvider()` returns `null` and fact selection falls back to a keyword ranker (ADR 0002 in
  `docs/ADR/0002-postgres-pgvector-for-embeddings.md`).
- Other gateways, wired but not selected (`apps/chat/lib/ai/gateways/`, requirements in `apps/chat/lib/config-requirements.ts`):
  - `vercel` - `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`
  - `anthropic` - `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL`
  - `openrouter` - `OPENROUTER_API_KEY`
  - `openai-compatible` - `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`
  - `litellm` - `LITELLM_BASE_URL`, `LITELLM_API_KEY`
- Model logos: the browser loads `https://models.dev/logos/{provider}.svg` (`apps/chat/components/model-selector-logo.tsx`);
  `models.dev` is whitelisted in `images.remotePatterns` of `apps/chat/next.config.ts`, together with
  `*.googleusercontent.com`, `avatars.githubusercontent.com` and `*.public.blob.vercel-storage.com`.

**Web search for deep research (backend order is fixed in `getSearchApi`, `apps/chat/tools/platform/deep-research/configuration.ts`):**
1. The research sidecar, whenever `ai.tools.deepResearch.researchSidecarUrl` is non-empty (`http://localhost:8099` in `apps/chat/chat.config.ts`).
2. Tavily - `TAVILY_API_KEY`, client `@tavily/core` (`apps/chat/tools/platform/steps/web-search.ts`).
3. Firecrawl - `FIRECRAWL_API_KEY`, client `@mendable/firecrawl-js` (same file).
4. None: the researcher refuses rather than pretending (`apps/chat/tools/platform/deep-research/research-availability.ts`).
- The plain `webSearch` and `urlRetrieval` tools are switched off in `apps/chat/chat.config.ts`. `EXA_API_KEY` is declared in
  `apps/chat/lib/env-schema.ts` and has no reader anywhere in `apps/chat`.

**Dormant, switched off in `apps/chat/chat.config.ts`:**
- Vercel Sandbox code execution (`@vercel/sandbox`; `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN`, `VERCEL_SANDBOX_RUNTIME`,
  `VERCEL_SANDBOX_RUNTIME_PYTHON`, `VERCEL_SANDBOX_RUNTIME_JAVASCRIPT`; `apps/chat/tools/platform/code-execution.shared.ts`).
- MCP connectors (`@ai-sdk/mcp`, `@modelcontextprotocol/sdk`; `apps/chat/lib/ai/mcp/`, `apps/chat/trpc/routers/mcp.router.ts`,
  callback route `apps/chat/app/api/mcp/oauth/callback/route.ts`). Credentials would be encrypted with `MCP_ENCRYPTION_KEY`
  (`apps/chat/lib/db/encrypted-text.ts`).
- Image and video generation, attachments, the Electron desktop auth plugin.

## The research sidecar (`apps/research`)

A FastAPI service the app reaches only over HTTP; it owns every call to a demand-signal source (`docs/ARCHITECTURE.md`).

**Endpoints (`apps/research/app/main.py`):**
- `GET /v1/health` - open; reports `hosted`, `caller_auth` (`token`, `loopback-only` or `unauthenticated`), credential NAMES present,
  unknown source ids and each source's gate state. Never a value.
- `POST /v1/signals/{source_id}` - runs exactly one source. Body: `query`, `limit` (1 to 100, default 25), `date_from`, `date_to`,
  `options`. An upstream failure is HTTP 200 with `{ok: false, kind, detail}`; kinds are `blocked`, `unavailable`, `rate-limited`,
  `disabled`, `missing-credential`, `schema-drift` (`apps/chat/lib/signals/sidecar.ts::normalizeFailureKind`). Results go through
  dedupe, weighted RRF fusion, rerank and grounding in `apps/research/app/pipeline/`. A signal carries no author.
- `POST /v1/simulate` - OASIS persona simulation; at most 10 personas, pitch up to 2000 characters, 1 to 10 rounds. Named refusals
  include `oasis-not-installed`, `unknown-simulation-model`, `invalid-personas`, `no-simulation-database` and
  `simulation-schema-drift` (`apps/research/app/simulation/oasis_runner.py`), plus `simulation-failed`, `no-reactions` and
  `too-few-reactions` (`apps/research/app/main.py`).

**Clients in the app:** `apps/chat/lib/signals/sidecar.ts` (45 s default timeout), `apps/chat/lib/research/sidecar-simulation.ts`
(300 s), `apps/chat/tools/platform/deep-research/sidecar-search.ts` (one search step is capped at 30 s by
`apps/chat/tools/platform/deep-research/research-clock.ts`).

**Address:** the config key `ai.tools.deepResearch.researchSidecarUrl` in `apps/chat/chat.config.ts`, not an environment variable
(`docs/ADR/0001-stack-as-found.md`). Empty disables every sidecar source.

**Caller auth (`apps/research/app/main.py::require_caller`, `docs/ADR/0005-sidecar-caller-auth.md`):**
- `RESEARCH_SIDECAR_TOKEN` set on the sidecar: every caller sends `Authorization: Bearer <token>` (constant-time compare). The app
  sends it from `env.RESEARCH_SIDECAR_TOKEN`. Set the same value on both sides whenever the app reaches the sidecar over a network.
- Unset and `RESEARCH_SIDECAR_ALLOW_UNAUTHENTICATED` true: any caller. Only for the compose container (`docker-compose.yml`).
- Unset otherwise: loopback callers only, one startup warning. 401 and 403 from the sidecar map to `missing-credential` in the app.
- Endpoints spend money (model key, search calls), so every port is published on `127.0.0.1` only (`docker-compose.yml`).

**Sources (`apps/research/app/sources/`; descriptors in `registry.py`, ids in `apps/research/app/config.py::KNOWN_SOURCE_IDS`):**

| id | Upstream | Credential | Default | Notes |
|---|---|---|---|---|
| `hackernews` | `https://hn.algolia.com/api/v1/search`, permalinks on `news.ycombinator.com` | none | on | `apps/research/app/sources/hackernews.py`, quality 0.75 |
| `web-keyless` | SearXNG at `RESEARCH_SEARXNG_URL` (`/search?format=json`), then `https://html.duckduckgo.com/html/` | none | on | `apps/research/app/sources/web_search_keyless.py`; a fully blocked ladder raises `SourceBlocked`; quality 0.5 |
| `github` | `https://api.github.com/search/issues` (issues, `created:` window, sorted by reactions) | `GITHUB_TOKEN` | off | `apps/research/app/sources/github.py`; missing token is `missing-credential`, never a keyless fallback; quality 0.7 |
| `arctic-shift` | `https://arctic-shift.photon-reddit.com/api/posts/search` | none | off | `apps/research/app/sources/arctic_shift.py`; the only Reddit lane; needs `options.subreddits`; asks for a field list without the author; 1 request per second, no retries, 25 s per lane; quality 0.6 |

- All four descriptors are allowed in hosted and self-host mode today; the gate machinery (`apps/research/app/sources/base.py::assert_permitted`,
  mirrored by `apps/chat/lib/signals/provider.ts::decideProviderGate`) checks, in order: hosted bar, self-host bar, operator toggle,
  credentials. Reasoning for the Reddit policy: `apps/research/app/sources/reddit_gate.py`.
- A source id lives in four places that must agree: `apps/research/app/sources/registry.py`, `apps/research/app/config.py`,
  `apps/chat/lib/signals/providers.ts` and `apps/chat/lib/signals/types.ts` (`.claude/rules/research-sources.md`).
- Fetching is stdlib `urllib` only (`apps/research/app/http.py`): HTTPS required except for private addresses (the local SearXNG),
  an honest `User-Agent` for JSON APIs, a browser one only for DuckDuckGo's HTML page; 403 raises `SourceBlocked`, 429 raises
  `SourceRateLimited`, anything else `SourceUnavailable`.
- SearXNG is opt-in (AGPL-3.0): `docker-compose.searxng.yml` starts `searxng/searxng:latest` as `ic-searxng` on `127.0.0.1:8888`,
  configured by `docker/searxng/settings.yml` (JSON output on, limiter off). Compose variable: `SEARXNG_SECRET`.

**Simulation (`apps/research/app/simulation/oasis_runner.py`):**
- OASIS (`camel-oasis` 0.2.6, extra `simulation`) drives the model through CAMEL's OpenAI platform; the agent graph is in-memory igraph
  and each run writes a SQLite `simulation.db` (`OASIS_DB_PATH`). No graph database.
- Provider: OpenAI chat completions, or any OpenAI-compatible gateway at `RESEARCH_SIM_BASE_URL`. The model id is checked with
  `GET {base}/models/{id}` before a run.
- Variables, all read in the sidecar process: `OPENAI_API_KEY` (the app's copy is irrelevant), `RESEARCH_SIM_MODEL` (default `gpt-5.6-luna`),
  `RESEARCH_SIM_BASE_URL`, `RESEARCH_SIM_REASONING_EFFORT` (unset means derived from the model), `RESEARCH_SIM_CONCURRENCY` (default 8).
- The compose `research` service passes the `RESEARCH_SIM_*` variables but does not forward `OPENAI_API_KEY`, and it builds the `base`
  stage, which has no OASIS (`docker-compose.yml`, `apps/research/Dockerfile`); simulation there answers `oasis-not-installed`.
  Run the sidecar from its venv with the `simulation` extra to simulate.

## Data Storage

**Databases:**
- Postgres 17 with pgvector (container `ic-pg`, database `ideacheck`, host port 5433 on loopback; `docker-compose.yml`).
  - Connection: `DATABASE_URL`
  - Client: `postgres` (postgres.js) with Drizzle (`apps/chat/lib/db/client.ts`); schema `apps/chat/lib/db/schema.ts`;
    docs `docs/DATABASE.md`.
  - Embeddings: `ProjectFact.embedding` is `vector(1536)` with an HNSW cosine index, in the same database.
  - Migrations: `apps/chat/lib/db/migrations/`, applied by `apps/chat/lib/db/migrate.ts`, which runs only when `VERCEL_ENV=production`
    (`bun run build` runs it first; `db:migrate` forces that variable). The local database is built with `db:push` and is never migrated.
  - Optional branching: `db:branch:*` scripts and `apps/chat/scripts/with-db.sh` swap `DATABASE_URL` for a Neon branch through
    `bunx neonctl` when a `.neon-branch` file exists. Inherited from ChatJS; the local stack does not use it.
- SQLite files: evalite results (`apps/chat/evals/db/evalite.db`, `apps/chat/evalite.config.ts`) and the sidecar's per-run OASIS database.

**File Storage:**
- Vercel Blob through `files-sdk` (`apps/chat/lib/storage-provider.ts`, `apps/chat/lib/file-storage.ts`), private access, keys carry a
  digest of the owner id. Two credential modes: `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` plus `VERCEL_OIDC_TOKEN` (Vercel builds set
  it; `vercel env pull` writes it locally; it is short-lived, never a pasted long-lived value). The adapter
  (`@vercel/blob`) reads them; app code only declares them (`apps/chat/lib/env-schema.ts`, `turbo.json`) and checks that one mode
  is met (`apps/chat/scripts/check-env.ts::validateStorage`, rules in `apps/chat/lib/storage-provider-metadata.ts`). Every read
  streams through `/api/files/content` after the access check, with `Cache-Control: private, no-store`; nothing redirects to a
  provider link. Unused today:
  `features.attachments` is false and image generation is off in `apps/chat/chat.config.ts`.
- The export is never written on the server: the app returns a plan and the browser downloads files (`apps/chat/lib/export/handoff.ts`).

**Caching:**
- Valkey 9.1 (protocol-compatible with Redis; container `ic-redis`, host port 6380 on loopback), client `redis` 5.x.
  - Connection: `REDIS_URL` (optional)
  - Uses: resumable chat streams (`resumable-stream`, key prefix `ideacheck:resumable-stream`, `apps/chat/app/(chat)/api/chat/route.ts`)
    and anonymous-visitor rate-limit counters (`apps/chat/lib/utils/rate-limit.ts`).
  - Without it streams are not resumable and the anonymous rate limit passes every request (it fails open, also when Redis errors).

## Authentication & Identity

**Auth Provider:**
- better-auth with the Drizzle adapter (`apps/chat/lib/auth.ts`; route `apps/chat/app/api/auth/[...all]/route.ts`; client
  `apps/chat/lib/auth-client.ts`). Plugins: `lastLoginMethod`, `nextCookies` (must stay last); the Electron plugin only if
  `desktopApp.enabled`. Session cookie cache is 5 minutes.
  - Secret: `AUTH_SECRET`. Trusted origin: `APP_URL` (else `VERCEL_URL`, else localhost) via `apps/chat/lib/url.ts::getBaseUrl`.
  - Social providers, each active only when both halves are set and neither is a placeholder: Google (`AUTH_GOOGLE_ID`,
    `AUTH_GOOGLE_SECRET`), GitHub (`AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`), Vercel (`VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`).
    All three flags are false in `apps/chat/chat.config.ts`.
  - Local sign-in: `GET /api/dev-login`, only when `NODE_ENV` is `development` (`apps/chat/app/api/dev-login/route.ts`).
  - Anonymous visitors: HMAC-signed cookie with remaining credits (`apps/chat/lib/anonymous-session-server.ts`), limits from the
    `anonymous` block of `apps/chat/chat.config.ts`.
  - Page guard `apps/chat/proxy.ts`; it does not cover `/api/*`, so every route, tRPC procedure and server action checks the session itself.
  - Playwright switches auth off with `PLAYWRIGHT`, `PLAYWRIGHT_TEST_BASE_URL` or `CI_PLAYWRIGHT`
    (`apps/chat/lib/playwright-test-environment.ts`); never set them in a deployed environment.

## Monitoring & Observability

**Error Tracking:** None. No vendor telemetry by design (`apps/chat/instrumentation.ts` is a no-op).

**Logs:**
- App: pino through `apps/chat/lib/logger.ts` (`createModuleLogger`), plus `console` in route handlers.
- Sidecar: Python `logging` (`research.sidecar`); `GET /v1/health` is the operator-facing diagnosis for a thin research report.
- Spend: per-turn cents on `UserCredit`, naming any model it could not price (`apps/chat/lib/credits/`).

## CI/CD & Deployment

**Hosting:** Nothing is deployed. `apps/chat/vercel.json` targets Vercel (`bun install`, `bun run build`, one cron);
`services.hosting` in `apps/chat/chat.config.ts` says "Vercel". The sidecar needs a private container from `apps/research/Dockerfile`.

**CI Pipeline:**
- GitHub Actions, one workflow: `.github/workflows/ci.yml` (jobs `changes`, `typescript`, `python`, `integrity`, `ci-success`; runner
  `ubuntu-24.04`). Triggers: `pull_request`, and `push` to `main`. No secrets, no `schedule`, no `workflow_run`, no `release`.
- Actions pinned to commit SHAs with version comments: `actions/checkout` v7.0.1, `oven-sh/setup-bun` v2.2.0, `actions/cache` v6.1.0,
  `actions/setup-python` v7.1.0, `dorny/paths-filter` v4.0.3.
- Required check: `ci-success` (`.github/rulesets/main.json`, applied on GitHub at go-live). The `integrity` job runs
  `scripts/test-integrity.sh` on pull requests (fails deleted tests, `.only`/skip markers, a lower test count).
- Dependabot (`.github/dependabot.yml`): weekly, 7-day cooldown, grouped minor and patch, for `bun`, `pip` (`apps/research`),
  `github-actions`, `docker` (`apps/research`) and `docker-compose`. It ignores `mcp >= 2` and Python minor/major bumps.
- Playwright e2e is local only.

## Environment Configuration

**Required env vars (app):** `DATABASE_URL`, `AUTH_SECRET`. In practice also `OPENAI_API_KEY`: the selected gateway throws
"OPENAI_API_KEY is not configured" without it, while `bun run dev:local` only warns (`apps/chat/scripts/check-env.ts --dev`).

**Optional env vars (app), by purpose:**
- Model gateways: `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, `OPENROUTER_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`,
  `OPENAI_COMPATIBLE_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `LITELLM_BASE_URL`, `LITELLM_API_KEY`.
- Research: `RESEARCH_ENABLED_SOURCES` and `RESEARCH_SIDECAR_TOKEN` (the same variables the sidecar reads), `GITHUB_TOKEN` (the app
  only checks that it is set, in `apps/chat/tools/platform/deep-research/deployment-mode.ts`; the sidecar uses it).
  `RESEARCH_HOSTED` and `RESEARCH_MAX_INPUT_TOKENS` are declared in the schema and have no reader in `apps/chat`: the app's hosted
  flag is `ai.tools.deepResearch.hosted` in `apps/chat/chat.config.ts` (false there, for local use only), and the sidecar reads
  `RESEARCH_HOSTED` on its own (default hosted).
- Search backends: `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`, `EXA_API_KEY` (unread).
- Stores: `REDIS_URL`, `BLOB_READ_WRITE_TOKEN`, `BLOB_STORE_ID` (with `VERCEL_OIDC_TOKEN`, listed under model gateways).
- Cron and platform: `CRON_SECRET`, `APP_URL`, `VERCEL_URL`, `VERCEL_ENV`, `VERCEL_PROJECT_PRODUCTION_URL`.
- Dormant features: `MCP_ENCRYPTION_KEY`, the `VERCEL_SANDBOX_*`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN` group.
- Dev and test: `PORT`, `DEBUG`, `PLAYWRIGHT`, `PLAYWRIGHT_TEST_BASE_URL`, `CI_PLAYWRIGHT`, `CHATJS_DEV_SLOT`.

**Sidecar-only env vars:** `RESEARCH_HOSTED`, `RESEARCH_ENABLED_SOURCES`, `RESEARCH_SIDECAR_TOKEN`,
`RESEARCH_SIDECAR_ALLOW_UNAUTHENTICATED`, `RESEARCH_SEARXNG_URL`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, `RESEARCH_SIM_MODEL`,
`RESEARCH_SIM_BASE_URL`, `RESEARCH_SIM_REASONING_EFFORT`, `RESEARCH_SIM_CONCURRENCY`. Defaults fail closed: hosted, only
`hackernews,web-keyless`, unknown ids refused and listed at `/v1/health`, loopback-only callers (`apps/research/app/config.py`).
`docker-compose.yml` sets `RESEARCH_HOSTED=false` and `RESEARCH_SIDECAR_ALLOW_UNAUTHENTICATED=true` for the local container only;
neither line may be copied into a deployed environment.

**Where a variable must be declared:** `apps/chat/lib/env-schema.ts`, the repo-root `.env.example`, `turbo.json` `globalEnv` (strict
mode drops unlisted names; census test `apps/chat/lib/env-schema.test.ts`), and `apps/chat/scripts/check-env.ts` when a feature needs
it. `RESEARCH_ENABLED_SOURCES` must stay in `globalEnv`. The sidecar's own variables are not turbo's business.

**Secrets location:** the repo-root `.env.local` (gitignored). No secret manager, and CI holds no secrets. The compose file passes
`RESEARCH_SIDECAR_TOKEN`, `GITHUB_TOKEN`, `RESEARCH_SEARXNG_URL` and `RESEARCH_SIM_*` through from the invoking environment.


## Webhooks & Callbacks

**Incoming:**
- `GET /api/cron/cleanup` - Vercel cron, daily (`apps/chat/vercel.json`). Requires `Authorization: Bearer <CRON_SECRET>`; refuses every
  caller when the secret is unset, compares digests in constant time (`apps/chat/app/api/cron/cleanup/route.ts`). Deletes unreferenced
  stored files, and returns `skipped` while attachments and image generation are both off.
- `/api/auth/*` - better-auth handler, including OAuth provider callbacks when a provider is enabled
  (`apps/chat/app/api/auth/[...all]/route.ts`).
- `/api/mcp/oauth/callback` - MCP OAuth redirect target, inert while MCP is off.
- App endpoints, not webhooks: `/api/chat`, `/api/chat/prepare`, `/api/chat/[id]/stream`, `/api/files/upload`, `/api/files/content`,
  `/api/chat-model`, `/api/trpc/[trpc]` (all under `apps/chat/app/`), and server actions in `apps/chat/app/actions/`.

**Outgoing:** No webhooks are sent. Outbound calls are the ones listed above: OpenAI, the sidecar, and from the sidecar the four sources
and an optional SearXNG and OpenAI-compatible gateway; plus Tavily or Firecrawl if a key is set.

---

*Integration audit: 2026-11-12*
