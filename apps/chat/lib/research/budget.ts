import type { ResearchShape } from "./types";

/**
 * PRE-FLIGHT TOKEN BUDGET. This module decides whether a research run is
 * allowed to START. It never measures a run in flight and it never stops one
 * halfway.
 *
 * WHY IT EXISTS. One full research pass is 600k–1M input tokens. The fan-out
 * multiplies that by the number of role researchers, and the loop multiplies it
 * again by breadth^depth. Under BYOK in self-host that is the user's own money,
 * which is exactly why BYOK was chosen — but a hosted demo shares one key
 * across strangers, and there the failure mode is not "expensive", it is "the
 * first visitor drains the month's budget in ninety seconds".
 *
 * WHY IT REFUSES RATHER THAN TRUNCATES. A mid-run cutoff spends the whole
 * budget and returns a report with a hole in it — the worst of both. Refusing
 * at t=0 costs nothing and the message can name the exact knob to turn down.
 *
 * This whole file is PURE: arithmetic over plain numbers, no clock, no I/O, no
 * model. Everything here is unit-tested, and the projection it produces is the
 * same number the caller shows the user when it refuses.
 */

// ─────────────────────────────────────────────────────────────────────────────
// (a) THE SHAPE OF THE TREE. Pure combinatorics over ResearchShape.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * dzhng/deep-research halves breadth at every level (`src/deep-research.ts`
 * @1f8f3e28, line 216: `const newBreadth = Math.ceil(breadth / 2)`). Ported
 * verbatim because the halving is what stops the tree exploding, and because
 * the budget projection must model the SAME tree the loop actually walks — a
 * projection that disagreed with the loop would be worse than no projection.
 */
export function nextBreadth(breadth: number): number {
  return Math.ceil(breadth / 2);
}

/** Depth counts down to zero; zero means "do not recurse". */
export function nextDepth(depth: number): number {
  return depth - 1;
}

/**
 * Guard against a shape that would make the projection meaningless.
 * Non-integer, non-finite, negative and absurdly large shapes all fail here
 * rather than producing a plausible-looking number.
 *
 * The upper bounds are deliberately low. breadth 12 / depth 6 already projects
 * past any sane budget, so a shape beyond them is a bug or an attack, not a
 * preference.
 */
const MAX_BREADTH = 12;
const MAX_DEPTH = 6;

export function isUsableShape(shape: ResearchShape): boolean {
  const { breadth, depth } = shape;
  return (
    Number.isInteger(breadth) &&
    Number.isInteger(depth) &&
    breadth >= 1 &&
    depth >= 1 &&
    breadth <= MAX_BREADTH &&
    depth <= MAX_DEPTH
  );
}

/**
 * How many SERP queries one researcher will run.
 *
 * At each node the loop asks the model for `breadth` queries, runs a search per
 * query, then recurses once per query with half the breadth and one less depth.
 * So: `q(b, d) = b + b * q(ceil(b/2), d - 1)`, terminating at `d === 1`.
 */
export function projectQueryCount(shape: ResearchShape): number {
  const { breadth, depth } = shape;
  if (depth <= 0 || breadth <= 0) {
    return 0;
  }
  if (depth === 1) {
    return breadth;
  }
  const childShape: ResearchShape = {
    breadth: nextBreadth(breadth),
    depth: nextDepth(depth),
  };
  return breadth + breadth * projectQueryCount(childShape);
}

/**
 * How many model calls one researcher will make.
 *
 * Two kinds, and they are NOT the same size, which is why they are counted
 * separately rather than lumped into one "calls" number:
 *  - one query-planning call per NODE of the tree (small prompt), and
 *  - one learning-extraction call per QUERY (large prompt — it carries the
 *    fetched page contents, and it is where essentially all the money goes).
 */
export function projectPlanningCalls(shape: ResearchShape): number {
  const { breadth, depth } = shape;
  if (depth <= 0 || breadth <= 0) {
    return 0;
  }
  if (depth === 1) {
    return 1;
  }
  const childShape: ResearchShape = {
    breadth: nextBreadth(breadth),
    depth: nextDepth(depth),
  };
  return 1 + breadth * projectPlanningCalls(childShape);
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE COST MODEL. Deliberately crude, deliberately pessimistic.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-call token sizes. These are UPPER BOUNDS, not averages.
 *
 * A budget cap built on averages under-projects exactly the runs that blow the
 * budget — the ones where every page is long. Over-projecting refuses a run
 * that would have fit, which is recoverable (turn the knob down); under-
 * projecting spends money that is already gone.
 *
 * `extractionInputTokens` is derived from dzhng's own numbers: it trims each
 * page to 25,000 characters and takes 5 results per query
 * (`src/deep-research.ts` @1f8f3e28), so ~125,000 characters ≈ 31,000 tokens at
 * the conventional 4 chars/token, rounded up for the prompt scaffolding.
 */
export type ResearchCostModel = {
  /** Input tokens for one query-planning call. */
  planningInputTokens: number;
  /** Input tokens for one learning-extraction call (the expensive one). */
  extractionInputTokens: number;
  /** Input tokens for the single final-report call per researcher. */
  finalReportInputTokens: number;
};

export const DEFAULT_COST_MODEL: ResearchCostModel = {
  planningInputTokens: 2000,
  extractionInputTokens: 32_000,
  finalReportInputTokens: 24_000,
};

export type BudgetProjectionInput = {
  shape: ResearchShape;
  /**
   * How many role researchers run concurrently. The fan-out is the whole point
   * of Step 5, and it is also the term that most often turns an affordable run
   * into an unaffordable one — four roles is four times the bill.
   */
  researcherCount: number;
  costModel?: ResearchCostModel;
};

export type BudgetProjection = {
  /** Per single researcher. */
  queriesPerResearcher: number;
  planningCallsPerResearcher: number;
  /** Across the whole fan-out. */
  totalQueries: number;
  totalModelCalls: number;
  totalInputTokens: number;
};

/**
 * PURE. Projects the cost of a run before a single token is spent.
 *
 * Returns `null` for an unusable shape rather than a zero or a NaN. A caller
 * that mistook "cannot project" for "projected zero" would wave through
 * precisely the malformed run this function exists to stop, so the impossible
 * case gets its own type rather than a sentinel number.
 */
export function projectResearchCost(
  input: BudgetProjectionInput
): BudgetProjection | null {
  const { shape, researcherCount } = input;
  const costModel = input.costModel ?? DEFAULT_COST_MODEL;

  if (!isUsableShape(shape)) {
    return null;
  }
  if (!Number.isInteger(researcherCount) || researcherCount < 1) {
    return null;
  }

  const queriesPerResearcher = projectQueryCount(shape);
  const planningCallsPerResearcher = projectPlanningCalls(shape);

  const perResearcherTokens =
    planningCallsPerResearcher * costModel.planningInputTokens +
    queriesPerResearcher * costModel.extractionInputTokens +
    costModel.finalReportInputTokens;

  return {
    queriesPerResearcher,
    planningCallsPerResearcher,
    totalQueries: queriesPerResearcher * researcherCount,
    totalModelCalls:
      (planningCallsPerResearcher + queriesPerResearcher + 1) * researcherCount,
    totalInputTokens: perResearcherTokens * researcherCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) THE DECISION. One function, and it fails closed.
// ─────────────────────────────────────────────────────────────────────────────

export type ResearchBudget = {
  /**
   * The hard ceiling on projected input tokens for ONE run.
   * `null` means "no cap" and is only legal when `hosted` is false — see the
   * guard in `decideResearchBudget`.
   */
  maxInputTokensPerRun: number | null;
  /**
   * True when this deployment shares one provider key across users. Hosted mode
   * may never run uncapped: an absent cap in hosted mode is a misconfiguration,
   * and the safe reading of a misconfiguration is REFUSE.
   */
  hosted: boolean;
};

export type BudgetDecision =
  | { allowed: true; projection: BudgetProjection; reason: string }
  | { allowed: false; projection: BudgetProjection | null; reason: string };

function refuse(
  projection: BudgetProjection | null,
  reason: string
): BudgetDecision {
  return { allowed: false, projection, reason };
}

/**
 * THE PRE-FLIGHT GATE. Same discipline as `decideGate`: most-severe-first, flat
 * early returns, and every refusal interpolates the actual numbers into
 * `reason` AT THE POINT OF DECISION, where they are still in scope.
 *
 * Every branch that cannot compute a defensible answer refuses. There is no
 * path where an unknown becomes an allow.
 */
export function decideResearchBudget(
  input: BudgetProjectionInput,
  budget: ResearchBudget
): BudgetDecision {
  // 1. The shape or the researcher count is nonsense. Refuse before costing it.
  const projection = projectResearchCost(input);
  if (projection === null) {
    return refuse(
      null,
      `Research shape is out of range (breadth ${input.shape.breadth}, depth ${input.shape.depth}, ${input.researcherCount} researchers). Breadth must be 1-${MAX_BREADTH}, depth 1-${MAX_DEPTH}, researchers at least 1.`
    );
  }

  const cap = budget.maxInputTokensPerRun;

  // 2. No cap configured. Legal ONLY in self-host, where the key is the user's
  //    own. In hosted mode an absent cap is a misconfiguration and refusing is
  //    the only reading that cannot cost someone else money.
  if (cap === null) {
    if (budget.hosted) {
      return refuse(
        projection,
        `Hosted mode has no research token cap configured, so this run cannot be authorised. Projected ${projection.totalInputTokens.toLocaleString("en-US")} input tokens across ${input.researcherCount} researchers.`
      );
    }
    return {
      allowed: true,
      projection,
      reason: `Self-host mode with no cap: proceeding with a projected ${projection.totalInputTokens.toLocaleString("en-US")} input tokens across ${input.researcherCount} researchers.`,
    };
  }

  // 3. A cap that is not a usable positive number is a misconfiguration, and a
  //    misconfigured ceiling must not read as an infinite one.
  if (!Number.isFinite(cap) || cap <= 0) {
    return refuse(
      projection,
      `The research token cap is not a usable number (${String(cap)}), so no run can be authorised.`
    );
  }

  // 4. The actual comparison.
  if (projection.totalInputTokens > cap) {
    return refuse(
      projection,
      `Refusing to start: projected ${projection.totalInputTokens.toLocaleString("en-US")} input tokens exceeds the ${cap.toLocaleString("en-US")} token budget for one run (${input.researcherCount} researchers x ${projection.queriesPerResearcher} queries at breadth ${input.shape.breadth}, depth ${input.shape.depth}). Reduce breadth, depth, or the number of researchers.`
    );
  }

  return {
    allowed: true,
    projection,
    reason: `Projected ${projection.totalInputTokens.toLocaleString("en-US")} of ${cap.toLocaleString("en-US")} budgeted input tokens.`,
  };
}

/**
 * PURE. Finds the largest shape that fits the budget, searching only shapes the
 * caller would actually accept. Returns `null` when even the smallest usable
 * shape is too expensive — which is a real answer, not a failure: it means the
 * budget cannot fund research at all and the operator must raise it.
 *
 * This exists so a refusal can say "try breadth 2, depth 2" instead of "too
 * expensive, good luck". A refusal the user cannot act on is a dead end.
 */
export function largestAffordableShape(
  input: Omit<BudgetProjectionInput, "shape">,
  budget: ResearchBudget,
  ceiling: ResearchShape
): ResearchShape | null {
  if (!isUsableShape(ceiling)) {
    return null;
  }
  let best: ResearchShape | null = null;
  let bestQueries = 0;

  for (let depth = 1; depth <= ceiling.depth; depth++) {
    for (let breadth = 1; breadth <= ceiling.breadth; breadth++) {
      const shape: ResearchShape = { breadth, depth };
      const decision = decideResearchBudget({ ...input, shape }, budget);
      if (!decision.allowed) {
        continue;
      }
      const queries = decision.projection.totalQueries;
      if (queries > bestQueries) {
        bestQueries = queries;
        best = shape;
      }
    }
  }

  return best;
}
