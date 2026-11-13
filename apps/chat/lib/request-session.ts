import { headers } from "next/headers";
import { connection } from "next/server";
import { cache } from "react";
import { auth } from "@/lib/auth";

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
 * settings layout and the project screens share a single lookup.
 *
 * Server-side tRPC does its own lookup in `trpc/init.ts::createTRPCContext`,
 * with no barrier, and stays apart from this one. Both ways of joining them
 * broke the Next 16.4.5 dev server on the first load after sign-in (clean
 * restarts, checked by hand): `connection()` inside the tRPC context reloaded
 * `/` about 25 times in a row, and having the context share a `cache()`d
 * lookup with this helper reloaded it 435 times before the test stopped it.
 * So every Server Component that calls server-side tRPC passes the barrier
 * itself before the call: the (chat) layout through this helper before its
 * prefetches, and each page through `trpc/server.tsx::getRequestQueryClient`.
 */
export const getRequestSession = cache(async () => {
  await connection();
  return await auth.api.getSession({ headers: await headers() });
});
