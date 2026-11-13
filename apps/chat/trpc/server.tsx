import "server-only"; // <-- ensure this file cannot be imported from the client
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { connection } from "next/server";
import { cache } from "react";
import { createTRPCContext } from "./init";
import { makeQueryClient } from "./query-client";
import { appRouter } from "./routers/_app";

// IMPORTANT: Create a stable getter for the query client that
//            will return the same client during the same request.
export const getQueryClient = cache(makeQueryClient);

/**
 * The request's query client, for a page that prefetches or fetches through
 * server-side tRPC. Await it on its own line before the first call, never
 * inside a `Promise.all`.
 *
 * `await connection()` first: the tRPC context (`init.ts::createTRPCContext`)
 * looks the session up with no request-time barrier, and better-auth reads the
 * clock, which fails with `blocking-prerender-current-time` in a runtime
 * prerender stage (`lib/request-session.ts`). A page renders alongside its
 * layouts, so a layout's barrier does not cover it. The barrier cannot live in
 * the context itself: that, and having the context share
 * `getRequestSession`'s lookup, both made the Next 16.4.5 dev server reload
 * `/` over and over after sign-in. The (chat) layout reaches its prefetches
 * through `getRequestSession`, which awaits the same barrier.
 */
export async function getRequestQueryClient() {
  await connection();
  return getQueryClient();
}

export const trpc = createTRPCOptionsProxy({
  ctx: createTRPCContext,
  router: appRouter,
  queryClient: getQueryClient,
});

export function HydrateClient(props: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      {props.children}
    </HydrationBoundary>
  );
}
