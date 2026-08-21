import { createTRPCRouter } from "@/trpc/init";
import { chatRouter } from "./chat.router";
import { creditsRouter } from "./credits.router";
import { documentRouter } from "./document.router";
import { mcpRouter } from "./mcp.router";
import { phaseRouter } from "./phase.router";
import { projectRouter } from "./project.router";
import { settingsRouter } from "./settings.router";
import { voteRouter } from "./vote.router";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 *
 * THREE ROUTERS WERE REMOVED HERE on 2026-08-21, not three procedures: every
 * procedure in `export`, `persona` and `canvas` was mounted, authenticated and
 * reachable over HTTP with no caller anywhere in the app.
 *
 * - `export.buildPlan` was a duplicate of `app/actions/build-handoff.ts`, which
 *   is the one the export dialog calls. Two copies of an ownership check that
 *   drift independently.
 * - `canvas.getCanvas` was superseded by the server-rendered
 *   `lib/project/canvas-data.ts`, and `canvas.setTaskState` carried a business
 *   rule its own comment described as "the one place this file does hold a
 *   rule" — an unreachable mutation holding an invariant.
 * - `persona.regenerate` / `persona.versions` were the tRPC half of a feature
 *   whose UI is `app/actions` and `lib/personas/runtime.ts`.
 *
 * `createCaller` went with them: a server-side caller factory documented only
 * by its own JSDoc example and called by nothing.
 */

export const appRouter = createTRPCRouter({
  chat: chatRouter,
  credits: creditsRouter,
  vote: voteRouter,
  document: documentRouter,
  mcp: mcpRouter,
  phase: phaseRouter,
  project: projectRouter,
  settings: settingsRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
