import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDocumentById, getProjectById } from "@/lib/db/queries";
import { listPersonaVersions, regeneratePersona } from "@/lib/personas/runtime";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

/**
 * A thin wrapper. Every judgement — what grounds the prompt, when to refuse,
 * what gets persisted — already lives in lib/personas and is unit tested there.
 *
 * `regeneratePersona` NEVER THROWS, so there is no error boundary here: a
 * failure comes back as `{ artifact, version: null }` with
 * `artifact.degradedReasons` populated, which PersonaCard renders as a banner.
 * Turning that into a tRPC error would lose the reasons.
 */

/** Ownership check, copied from phase.router.ts so the two cannot drift. */
async function requireOwnedProject(projectId: string, userId: string) {
  const project = await getProjectById({ id: projectId });
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  }
  if (project.userId !== userId) {
    // Same message as NOT_FOUND on purpose: never confirm a project exists to
    // somebody who does not own it.
    throw new TRPCError({ code: "FORBIDDEN", message: "Project not found" });
  }
  return project;
}

export const personaRouter = createTRPCRouter({
  regenerate: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        /**
         * Reuse an existing persona's id to append a version; pass a fresh uuid
         * to start a new persona at v1.
         */
        documentId: z.string().uuid(),
        messageId: z.string().uuid(),
        latestUserMessage: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwnedProject(input.projectId, ctx.user.id);

      // appendVersion INSERTs under whatever documentId it is handed, so an
      // unchecked id would let a caller push a version into somebody else's
      // persona history — or move a persona between projects. A brand-new id
      // matches nothing and falls through, which is the v1 case.
      const existing = await getDocumentById({ id: input.documentId });
      if (existing) {
        if (existing.userId !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Document not found",
          });
        }
        if (
          existing.projectId !== null &&
          existing.projectId !== input.projectId
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Document belongs to a different project",
          });
        }
      }

      return await regeneratePersona({ ...input, userId: ctx.user.id });
    }),

  versions: protectedProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const existing = await getDocumentById({ id: input.documentId });
      // No rows is an empty history, not an error — the caller may hold the id
      // of a persona that has never been generated.
      if (existing && existing.userId !== ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Document not found",
        });
      }
      return await listPersonaVersions(input.documentId);
    }),
});
