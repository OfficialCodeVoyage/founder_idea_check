import type { CriterionEvaluation, GateDecisionValue } from "./types";
import { GateVerdictSchema } from "./types";

/**
 * THE REFUSAL HISTORY, AS SOMETHING A FOUNDER CAN LEARN FROM.
 *
 * `ProjectPhaseAttempt` has been written on every gate run since the ledger was
 * added and read by nothing. A bare list of "BLOCK, BLOCK, BLOCK, PASS" is
 * already better than nothing — but the useful fact is not that they were
 * refused four times, it is WHICH criterion they closed on attempt three and
 * which one is still open. That diff is what this computes.
 *
 * PURE. No database, no clock.
 */

export type AttemptRow = {
  attemptNo: number;
  decision: string;
  reason: string;
  nextQuestion: string | null;
  evaluatedAt: Date;
  /** The stored json blob. Genuinely unknown — it is parsed, never cast. */
  verdict: unknown;
};

/**
 * What the stored verdict turned out to contain.
 *
 * `readable: false` is not an empty criteria list. `decision` and `reason` are
 * NOT NULL columns, so a blob that no longer parses still sits behind a real
 * refusal with a real explanation — and rendering it as "no criteria were
 * unmet" would invert it into good news.
 */
export type AttemptDetail =
  | {
      readable: true;
      perCriterion: readonly CriterionEvaluation[];
      /** Criterion ids the judge did not mark met. */
      unmet: readonly string[];
    }
  | { readable: false; why: string };

export type AttemptStep = {
  attemptNo: number;
  decision: GateDecisionValue;
  reason: string;
  nextQuestion: string | null;
  evaluatedAt: Date;
  detail: AttemptDetail;
  /**
   * Criterion ids that stopped being unmet since the previous attempt — what
   * the founder actually fixed.
   */
  closed: readonly string[];
  /** Ids that became unmet, having been met before. A regression. */
  opened: readonly string[];
  /** Ids unmet in both. What the founder has not moved. */
  stillOpen: readonly string[];
};

const UNREADABLE =
  "the stored verdict no longer matches the shape this app expects, so its criterion detail cannot be shown — the decision and reason above are still what the gate wrote";

/** A criterion counts as unmet unless the judge positively marked it met. */
function unmetIds(perCriterion: readonly CriterionEvaluation[]): string[] {
  return perCriterion
    .filter((evaluation) => evaluation.status !== "met")
    .map((evaluation) => evaluation.criterionId);
}

function toDetail(verdict: unknown): AttemptDetail {
  const parsed = GateVerdictSchema.safeParse(verdict);
  if (!parsed.success) {
    return { readable: false, why: UNREADABLE };
  }
  return {
    readable: true,
    perCriterion: parsed.data.perCriterion,
    unmet: unmetIds(parsed.data.perCriterion),
  };
}

/**
 * PURE. The ledger, oldest first, with each step's diff against the one before.
 *
 * THE FIRST ATTEMPT HAS AN EMPTY DIFF, not a diff against an imagined empty
 * attempt. Reporting every criterion as "opened" on the first run would tell a
 * founder they had just broken eight things.
 *
 * A step whose verdict is unreadable also produces an empty diff, and so does
 * the step AFTER it: a diff needs both sides, and guessing across a hole would
 * attribute a change to the wrong attempt.
 */
export function describeAttemptSeries(
  rows: readonly AttemptRow[]
): AttemptStep[] {
  const steps: AttemptStep[] = [];
  let previousUnmet: readonly string[] | null = null;

  for (const row of rows) {
    const detail = toDetail(row.verdict);
    const unmet = detail.readable ? detail.unmet : null;

    const comparable = previousUnmet !== null && unmet !== null;
    const before = new Set(previousUnmet ?? []);
    const now = new Set(unmet ?? []);

    steps.push({
      attemptNo: row.attemptNo,
      decision: row.decision as GateDecisionValue,
      reason: row.reason,
      nextQuestion: row.nextQuestion,
      evaluatedAt: row.evaluatedAt,
      detail,
      closed: comparable ? [...before].filter((id) => !now.has(id)) : [],
      opened: comparable ? [...now].filter((id) => !before.has(id)) : [],
      stillOpen: comparable ? [...now].filter((id) => before.has(id)) : [],
    });

    previousUnmet = unmet;
  }

  return steps;
}
