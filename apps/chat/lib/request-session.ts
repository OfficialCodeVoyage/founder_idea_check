import { headers } from "next/headers";
import { connection } from "next/server";
import { cache } from "react";
import { auth } from "@/lib/auth";

/**
 * The raw session lookup, one per request: `getRequestSession` and
 * `trpc/init.ts::createTRPCContext` both read it, so a request that renders a
 * layout and runs server-side tRPC asks better-auth once.
 *
 * It has no request-time barrier of its own, and React `cache()` keeps the
 * first promise for the rest of the request: a lookup started before
 * `connection()` would read the clock inside a prerender stage and would be
 * reused by every later caller. So every Server Component that reaches it
 * through server-side tRPC (`trpc/server.tsx`) awaits `connection()` first:
 * the (chat) layout before its prefetches, and the models, connectors,
 * connector-details and shared-chat pages before theirs. A new server-side
 * prefetch, `fetchQuery` or caller needs the same `await connection()` ahead
 * of it. The barrier is not put inside `createTRPCContext` itself: that made
 * the Next 16.4.5 dev server reload `/` about 25 times in a row on the first
 * load after sign-in (checked by hand).
 *
 * The tRPC route handler (`app/api/trpc`) also creates its context through
 * here, but it runs outside a Server Component render: `cache()` does not
 * memoize there and there is no prerender stage to guard, so it needs neither.
 */
export const lookupRequestSession = cache(async () =>
  auth.api.getSession({ headers: await headers() })
);

/**
 * The signed-in session for the current request, for code that runs while a
 * Server Component renders (layouts and pages).
 *
 * `await connection()` comes first on purpose. With `cacheComponents` and
 * `partialPrefetching` (`next.config.ts`), `cookies()` and `headers()` resolve
 * in a runtime stage of the render, and that stage is still a prerender: a
 * clock read there fails with `blocking-prerender-current-time`. better-auth's
 * `getSession` reads the clock (`Date.now()`, `new Date()`) after only a few
 * crypto awaits while the session cookie cache is fresh (`lib/auth.ts`
 * `session.cookieCache`), so without `connection()` it finished inside that
 * stage. Next 16.4 split the runtime stage into four, which widened the
 * window enough for it to happen on the first load after sign-in.
 *
 * `connection()` rather than `io()`: the session decides redirects and who
 * the page is for, so it must wait for a real request and never be part of a
 * prefetch.
 *
 * Wrapped in React `cache()`, so within one request the (chat) layout, the
 * settings layout and the project screens share a single call, and the
 * lookup behind it is the same one server-side tRPC uses
 * (`lookupRequestSession`).
 */
export const getRequestSession = cache(async () => {
  await connection();
  return await lookupRequestSession();
});
