import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  getProjectPhaseAttempts,
  getProjectPhases,
} from "@/lib/db/phase-queries";
import { getProjectById } from "@/lib/db/queries";
import { resolveCurrentPhase } from "@/lib/phases/advance";
import { describeAttemptSeries } from "@/lib/phases/attempt-history";
import { toPhaseGateState } from "@/lib/phases/directive";
import { PHASE_COUNT } from "@/lib/phases/types";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

/**
 * The current phase's attempt ledger, projected to what the verdict card needs.
 *
 * NOT PART OF THE 3-SECOND POLL. `getState` is polled while a verdict is
 * pending, and re-reading the ledger there Zod-parsed every stored verdict on
 * every tick although the ledger only changes when a new attempt is recorded.
 * It is served by `currentLedger` below, which the client keys on the attempt
 * count, so it is fetched once per new attempt. The `attempts` procedure stays
 * separate because IT loads a phase the founder chose to open; this is the
 * phase they are already in.
 *
 * Projected rather than returned whole: `describeAttemptSeries` carries every
 * evaluation's `evidence` and `gap` prose, which is model-written text the
 * card does not read. Ids, decisions and the diff are all it needs.
 *
 * `unmet` stays NULLABLE all the way through. Null means the attempt had no
 * criterion state at all — an unreadable verdict, or a gate that failed closed
 * and scored nothing — and flattening it to `[]` would make that attempt read
 * as one where nothing was unmet.
 */
async function currentPhaseLedger({
  projectId,
  phaseKey,
  attemptCount,
}: {
  projectId: string;
  phaseKey: string;
  attemptCount: number;
}) {
  if (attemptCount === 0) {
    return [];
  }
  const rows = await getProjectPhaseAttempts({ projectId, phaseKey });
  return describeAttemptSeries(
    rows.map((row) => ({
      attemptNo: row.attemptNo,
      decision: row.decision,
      reason: row.reason,
      nextQuestion: row.nextQuestion,
      evaluatedAt: row.evaluatedAt,
      verdict: row.verdict,
    }))
  ).map((step) => ({
    attemptNo: step.attemptNo,
    decision: step.decision,
    unmet: step.detail.readable ? step.detail.unmet : null,
    closed: step.closed,
    opened: step.opened,
    stillOpen: step.stillOpen,
  }));
}

export const phaseRouter = createTRPCRouter({
  /**
   * THE REFUSAL LEDGER, which until now nothing read.
   *
   * `getProjectPhaseAttempts` has existed and been correct since the ledger was
   * built; it simply had no caller, so every gate verdict was appended forever
   * and no founder could see any of it. In the dev database that is 11 recorded
   * attempts — including a phase that took four — all invisible.
   *
   * A drill-down rather than part of the roster's first paint: loading all
   * eight phases' ledgers up front costs eight queries for history a founder
   * mostly will not open.
   */
  attempts: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        phaseKey: z.string().min(1),
      })
    )
    .query(async ({ ctx, input }) => {
      const project = await getProjectById({ id: input.projectId });
      // "No such project" and "not yours" are deliberately the same answer,
      // copied from getState below rather than reinvented.
      if (!project || project.userId !== ctx.user.id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
      const rows = await getProjectPhaseAttempts({
        projectId: input.projectId,
        phaseKey: input.phaseKey,
      });
      return describeAttemptSeries(
        rows.map((row) => ({
          attemptNo: row.attemptNo,
          decision: row.decision,
          reason: row.reason,
          nextQuestion: row.nextQuestion,
          evaluatedAt: row.evaluatedAt,
          verdict: row.verdict,
        }))
      );
    }),

  /**
   * The verdict card's ledger for the phase the founder is in.
   *
   * `attemptCount` is the CACHE KEY: the client passes the count `getState`
   * reported, so react-query fetches this once per new attempt instead of on
   * every poll. It also lets a phase never judged skip the database entirely.
   */
  currentLedger: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        phaseKey: z.string().min(1),
        attemptCount: z.number().int().min(0),
      })
    )
    .query(async ({ ctx, input }) => {
      const project = await getProjectById({ id: input.projectId });
      // Same answer for "no such project" and "not yours", as in `attempts`.
      if (!project || project.userId !== ctx.user.id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
      return currentPhaseLedger(input);
    }),

  getState: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Independent reads, so in parallel. The phase rows are only returned
      // after the ownership check below.
      const [project, rows] = await Promise.all([
        getProjectById({ id: input.projectId }),
        getProjectPhases({ projectId: input.projectId }),
      ]);
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
         * Which rule the gate broke on. NULL for a verdict stored before the
         * arm existed, and the card renders those under its generic heading —
         * the one they were written under. A default of any KIND here would
         * label old refusals with a reason the gate never gave.
         */
        obstacle: state?.obstacle ?? null,
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
        /**
         * HOW MANY TIMES THE GATE HAS RUN ON THIS PHASE — "Attempt 7".
         *
         * Read from the ProjectPhase row rather than from the ledger below,
         * which is sometimes shorter: verdicts written before the ledger
         * existed were overwritten in place and are gone. This column has been
         * incremented on every gate run since it existed and is the honest
         * count.
         *
         * Per-PHASE, unlike `assessmentCount` directly above, which sums every
         * phase because it exists to detect a verdict LANDING. Both are needed
         * and they are not interchangeable.
         */
        attemptCount: row?.attemptCount ?? 0,
        /**
         * WHAT THIS PHASE IS JUDGED AGAINST, so the card can show all eight
         * rows without a navigation. Sent from here rather than imported by the
         * component so the criteria and the verdict come from the same resolved
         * phase and cannot describe two different ones.
         */
        criteria: phase.exitCriteria.map((c) => ({
          id: c.id,
          description: c.description,
          severity: c.severity,
          closure: c.closure,
        })),
        /**
         * The judge's verdict per criterion, id and status only. EMPTY has two
         * causes — a gate that failed closed and a verdict that no longer
         * parses — and `criteriaAssessed` / `verdictReadable` above are what
         * tell them apart. It is never "all eight came back untouched".
         */
        perCriterion: state?.perCriterion ?? [],
        // The ledger (the attempt diff the card shows) is NOT here: it is
        // `currentLedger`, fetched once per new attempt rather than per poll.
      };
    }),
});
