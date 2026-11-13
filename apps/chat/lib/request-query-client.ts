import { connection } from "next/server";
import { getQueryClient } from "@/trpc/server";

/**
 * The request's query client, for a page that prefetches or fetches through
 * server-side tRPC. Await it on its own line before the first call, never
 * inside a `Promise.all`.
 *
 * `await connection()` first: the tRPC context looks the session up with no
 * barrier (see `lib/request-session.ts::getRequestSession`), and a page
 * renders alongside its layouts, so a layout's barrier does not cover it.
 *
 * Its own module, not `trpc/server.tsx`: with this helper there, importing
 * `connection` into that module made the Next 16.4.5 dev server reload `/`
 * 71 times after sign-in (clean restart, checked by hand). Not
 * `lib/request-session.ts` either, so the pages that only need the session
 * (login, device login, the project screens) do not import the tRPC router.
 */
export async function getRequestQueryClient() {
  await connection();
  return getQueryClient();
}
