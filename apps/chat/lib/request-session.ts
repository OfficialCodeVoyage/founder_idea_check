import { headers } from "next/headers";
import { connection } from "next/server";
import { auth } from "@/lib/auth";

/**
 * The signed-in session for the current request, for code that runs while a
 * Server Component renders (layouts, pages, and the tRPC context that
 * `prefetchQuery` builds during render).
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
 * prefetch. In route handlers and server actions `connection()` resolves at
 * once, so this is safe wherever the tRPC context is built.
 */
export async function getRequestSession() {
  await connection();
  return await auth.api.getSession({ headers: await headers() });
}
