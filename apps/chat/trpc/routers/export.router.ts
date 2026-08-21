import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getProjectFacts, getProjectPhases } from "@/lib/db/phase-queries";
import {
  getPersonaDocumentsByProjectId,
  getProjectById,
} from "@/lib/db/queries";
import { missingFromVerdict } from "@/lib/export/grounding";
import { buildHandoff } from "@/lib/export/handoff";
import { toExportPersonas } from "@/lib/export/persona";
import type { ExportPhaseState } from "@/lib/export/types";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

export const exportRouter = createTRPCRouter({
  /**
   * Returns the FULL described repository as `{path, contents}[]`.
   *
   * The client turns it into a download; nothing is written server-side. That is
   * the whole point of the pure/impure split — the same plan feeds a zip, a
   * filesystem write and a preview pane with no second code path.
   */
  buildPlan: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const project = await getProjectById({ id: input.projectId });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
      if (project.userId !== ctx.user.id) {
        // Same message as NOT_FOUND on purpose: never confirm a project exists
        // to somebody who does not own it.
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Project not found",
        });
      }

      const [factRows, phaseRows, personaRows] = await Promise.all([
        getProjectFacts({ projectId: input.projectId }),
        getProjectPhases({ projectId: input.projectId }),
        getPersonaDocumentsByProjectId({ projectId: input.projectId }),
      ]);

      const phases: ExportPhaseState[] = phaseRows.map((row) => ({
        phaseKey: row.phaseKey,
        status: row.status,
        decision: row.decision ?? null,
        reason: row.reason ?? null,
        nextQuestion: row.nextQuestion ?? null,
        // Parsed, not cast: `verdict` is a json column, i.e. genuinely unknown.
        missing: missingFromVerdict(row.verdict),
      }));

      return buildHandoff({
        project: { name: project.name, instructions: project.instructions },
        facts: factRows.map((row) => ({
          key: row.key,
          value: row.value,
          confidence: row.confidence,
          phaseKey: row.phaseKey,
          updatedAt: row.updatedAt,
        })),
        phases,
        personas: toExportPersonas(personaRows),
        // The ONLY clock in the whole feature, and it is here rather than inside
        // lib/export so the pure layer stays deterministic and testable.
        generatedAt: new Date(),
      });
    }),
});
