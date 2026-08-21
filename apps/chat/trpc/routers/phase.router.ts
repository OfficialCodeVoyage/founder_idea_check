import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getProjectPhases } from "@/lib/db/phase-queries";
import { getProjectById } from "@/lib/db/queries";
import { resolveCurrentPhase } from "@/lib/phases/advance";
import { toPhaseGateState } from "@/lib/phases/directive";
import { PHASE_COUNT } from "@/lib/phases/types";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

export const phaseRouter = createTRPCRouter({
  getState: protectedProcedure
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
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Project not found",
        });
      }

      // Reads the CURRENT phase rather than PHASE_ONE, so the rail follows a
      // PASS into phase 2. Same pure resolver the system prompt uses, so the
      // badge and the prompt cannot disagree about which phase this is.
      const rows = await getProjectPhases({ projectId: input.projectId });
      const { phase, workflowComplete } = resolveCurrentPhase(
        rows.map((r) => ({
          phaseKey: r.phaseKey,
          status: r.status as "locked" | "active" | "passed",
        }))
      );
      const row = rows.find((r) => r.phaseKey === phase.key) ?? null;
      // Parsed, not cast: `verdict` is a json column, i.e. genuinely unknown.
      const state = toPhaseGateState(row);

      return {
        phaseKey: phase.key,
        title: phase.title,
        order: phase.order,
        total: PHASE_COUNT,
        status: row?.status ?? "active",
        workflowComplete,
        decision: state?.decision ?? null,
        reason: state?.reason ?? null,
        nextQuestion: state?.nextQuestion ?? null,
        missing: state?.missing ?? [],
        /**
         * How many criteria the judge actually scored, and whether the stored
         * verdict still parses. The rail does not use either — it has one line
         * — but the verdict card must, or it would present a fail-closed BLOCK
         * (`perCriterion: []`, `missing: [reason]`) as a complete gap list of
         * one item. See PhaseGateState in lib/phases/directive.ts.
         */
        criteriaAssessed: state?.criteriaAssessed ?? 0,
        verdictReadable: state?.verdictReadable ?? true,
        /**
         * The rail's only client-visible signal that a post-turn pass has
         * LANDED. `after()` has none, so the rail polls until this number
         * CHANGES rather than guessing a delay.
         *
         * Summed across ALL phases, not the current row's `attemptCount`: a
         * PASS moves the rail onto a freshly activated row whose count is 0,
         * so a per-phase counter goes DOWN and change-detection against it
         * would miss the very verdict that advanced the phase.
         *
         * Monotonic: `recordGateVerdict` writes 1 on insert and
         * `attemptCount + 1` on conflict for every persisted verdict,
         * including the fail-closed one; `activateProjectPhase` only ever
         * INSERTs a row at 0 with onConflictDoNothing; nothing resets rows.
         */
        assessmentCount: rows.reduce((total, r) => total + r.attemptCount, 0),
      };
    }),
});
