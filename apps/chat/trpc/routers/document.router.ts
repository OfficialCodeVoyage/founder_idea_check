import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ArtifactKind } from "@/lib/artifacts/artifact-kind";
import {
  getDocumentsById,
  getOwnedDocumentById,
  getPublicDocumentsById,
  saveDocument,
} from "@/lib/db/queries";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "@/trpc/init";

export const documentRouter = createTRPCRouter({
  getDocuments: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const documents = await getDocumentsById({
        id: input.id,
        userId: ctx.user.id,
      });

      if (documents.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      return documents;
    }),

  getPublicDocuments: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const documents = await getPublicDocumentsById({ id: input.id });

      if (documents.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Public document not found",
        });
      }

      return documents;
    }),

  saveDocument: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        content: z.string(),
        title: z.string(),
        kind: z.custom<ArtifactKind>(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Owner-scoped, and the same NOT_FOUND for "someone else's" as for
      // "missing": an unscoped read here let any signed-in user append a
      // version to a document whose id they saw in a shared chat. The rule
      // is `lib/db/queries.ts::firstVersionOwner`.
      const lastDocument = await getOwnedDocumentById({
        id: input.id,
        userId: ctx.user.id,
      });

      if (!lastDocument) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      await saveDocument({
        id: input.id,
        content: input.content,
        title: input.title,
        kind: input.kind,
        userId: ctx.user.id,
        messageId: lastDocument.messageId,
      });

      return { success: true };
    }),
});
