---
paths:
  - "apps/chat/lib/auth.ts"
  - "apps/chat/lib/auth-client.ts"
  - "apps/chat/proxy.ts"
  - "apps/chat/app/api/dev-login/**"
  - "apps/chat/app/api/auth/**"
  - "apps/chat/app/api/cron/**"
  - "apps/chat/trpc/init.ts"
  - "apps/chat/lib/playwright-test-environment.ts"
---
# Auth — landmines

- **`proxy.ts` does not guard `/api/*`** (its `matcher` excludes `api`). Every route handler, tRPC procedure
  (`trpc/init.ts::protectedProcedure`) and server action checks the session and ownership itself.
- **`APP_URL` must equal the origin the browser uses.** better-auth builds `trustedOrigins` from it
  (`lib/auth.ts`); a mismatch makes every cookie-bearing POST to `/api/auth` fail with 403 `INVALID_ORIGIN`.
  `apps/chat/scripts/dev-local.sh` exports `http://localhost:$PORT`; use `localhost`, never `127.0.0.1`.
- **Playwright env vars switch auth off.** `PLAYWRIGHT`, `PLAYWRIGHT_TEST_BASE_URL` or `CI_PLAYWRIGHT` (any value
  but 0/false/no/off) make `proxy.ts` return early and the chat layout run with no session, and give
  `DATABASE_URL`/`AUTH_SECRET` test defaults (`lib/env-schema.ts`). Never set them in a deployed environment.
- **`/api/dev-login` exists only when `NODE_ENV === "development"`** (404 otherwise). It signs a session cookie
  for `dev@localhost` with `AUTH_SECRET`. Keep that guard first in the handler.
- **A shared secret read from env must be checked as set before it is compared.** `CRON_SECRET` is optional, and
  `` `Bearer ${undefined}` `` is the string `Bearer undefined`. Pattern:
  `app/api/cron/cleanup/route.ts::isAuthorizedCronRequest` (refuse when unset, constant-time compare).
- **Auth trusts only this deployment's own URL** (`lib/url.ts::getBaseUrl`). Never add `config.appUrl` to
  `trustedOrigins` or use it as `baseURL`: a fork inherits it pointing at a domain it does not own.
- **Placeholder credentials count as unset** (`lib/auth.ts`); do not add a provider that treats them as real.
