import type {
  CriterionEvaluation,
  ExitCriterion,
  GateVerdict,
} from "@/lib/phases/types";
import type {
  Blocker,
  BlockerAnalysis,
  BlockerAnalysisState,
  BlockerSeverity,
  UnblockingTask,
} from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ULTRAPLAN — BLOCKERS. THE PURE HALF, AND THERE IS NO OTHER HALF.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * gate.ts splits into (a) a pure decision function and (b) exactly one injected
 * async seam. This file is all (a) and no (b) — ON PURPOSE. Everything here is
 * a projection of a verdict the gate already produced, so a second model call
 * would be a second, unreviewed opinion about whether a founder is blocked, and
 * the two would drift. The gate decides; ultraplan only explains.
 *
 * That makes the whole module a total function of its inputs: no model, no DB,
 * no clock, no randomness. Given the same verdict it returns byte-identical
 * output, which is what lets the canvas key React nodes off `Blocker.id` and
 * `UnblockingTask.id` without the graph reshuffling on every re-render.
 *
 * THE FAILURE MODE THIS FILE EXISTS TO PREVENT, stated once:
 * components/phase-rail.tsx does `data.decision ?? "BLOCK"`, so a project whose
 * gate has NEVER RUN renders a red BLOCKED badge on turn 1 — while the phase
 * directive is telling the founder to just start talking. Fail-closed is right;
 * collapsing "not assessed" into "assessed and blocked" is not fail-closed, it
 * is a lie in the safe direction. analyzeBlockers() keeps the two apart:
 * `verdict === null` yields state "unassessed" and ZERO blockers, because there
 * is no evidence that anything is wrong yet.
 */

const NO_GAP_NAMED =
  "the gate marked this criterion unsatisfied but named no specific gap";

const NOT_RETURNED_BY_JUDGE =
  "the gate ran but returned no verdict for this criterion";

const NOT_A_DEFINED_CRITERION =
  "the gate returned a verdict for a criterion this phase does not define";

/**
 * Sort rank. Blocking first (a confirmed gap has a concrete next move), then
 * unknown (the move is "get evidence", which is weaker), then advisory (never
 * refuses advance, so it must never be the first thing a founder reads).
 */
const SEVERITY_RANK: Record<BlockerSeverity, number> = {
  blocking: 0,
  unknown: 1,
  advisory: 2,
};

export type AnalyzeBlockersInput = {
  /** Phase key, used to namespace ids so two phases' blockers never collide. */
  phaseKey: string;
  /**
   * The criteria the phase DEFINES, in definition order. Definition order is
   * the tiebreak for blocker ordering: the judge's array order is not stable
   * between runs, and a canvas whose task lane reorders every turn is unusable.
   */
  criteria: ExitCriterion[];
  /**
   * NULL means the gate has never produced a verdict for this phase. It does
   * NOT mean BLOCK. See the file header.
   */
  verdict: GateVerdict | null;
};

/** The three inputs every blocker is derived from, resolved together once. */
type BlockerContext = {
  criterionId: string;
  /** UNDEFINED when the judge named a criterion the phase does not define. */
  criterion: ExitCriterion | undefined;
  evaluation: CriterionEvaluation | undefined;
  /** Position in `criteria`; uncovered/unknown criteria sort after all of them. */
  order: number;
};

/**
 * Severity resolution, most-uncertain-first.
 *
 * Uncertainty dominates: if the gate could not read a criterion, or returned a
 * criterion we cannot look up, we do not get to claim how bad it is. Only once
 * we know WHICH criterion this is and that the judge actually reached a verdict
 * on it do we use the phase's declared severity — the same source of truth
 * gate.ts uses, so the canvas and the gate cannot disagree about which gaps are
 * advisory.
 */
function resolveSeverity(context: BlockerContext): BlockerSeverity {
  if (context.criterion === undefined) {
    return "unknown";
  }
  if (
    context.evaluation === undefined ||
    context.evaluation.status === "not-evaluable"
  ) {
    return "unknown";
  }
  // A non-met status with no gap named is indistinguishable from "we could not
  // tell" — gate.ts's normalizeEvaluation() escalates exactly this case to
  // not-evaluable, but a verdict read back out of the `verdict` json column has
  // NOT been through that function, so the rule is re-applied here rather than
  // assumed.
  if (!context.evaluation.gap?.trim()) {
    return "unknown";
  }
  return context.criterion.severity === "advisory" ? "advisory" : "blocking";
}

/** The sentence shown to the founder. Always the judge's words when it has any. */
function resolveBlockerText(context: BlockerContext): string {
  const gap = context.evaluation?.gap?.trim();
  if (gap) {
    return gap;
  }
  if (context.evaluation === undefined) {
    return NOT_RETURNED_BY_JUDGE;
  }
  if (context.criterion === undefined) {
    return NOT_A_DEFINED_CRITERION;
  }
  return NO_GAP_NAMED;
}

function taskId(
  phaseKey: string,
  criterionId: string,
  kind: UnblockingTask["kind"]
): string {
  return `${phaseKey}::${criterionId}::${kind}`;
}

/**
 * The one task derived from the criterion's own type — the concrete target the
 * phase author wrote down, not a paraphrase of the judge's prose.
 *
 * Returns NULL for a criterion we cannot see, which is what keeps
 * buildTasks() from asserting "establish fact X" about a criterion whose
 * definition we do not have.
 */
function criterionTargetTask(
  phaseKey: string,
  criterion: ExitCriterion
): UnblockingTask {
  const base = {
    criterionId: criterion.id,
    detail: criterion.description,
  };
  switch (criterion.type) {
    case "artifact-exists":
      return {
        ...base,
        id: taskId(phaseKey, criterion.id, "establish-fact"),
        kind: "establish-fact",
        title: `Establish "${criterion.factKey}"`,
        producesFactKey: criterion.factKey,
      };
    case "metric-threshold":
      return {
        ...base,
        id: taskId(phaseKey, criterion.id, "raise-metric"),
        kind: "raise-metric",
        title: `Move ${criterion.metric} to ${criterion.operator} ${criterion.threshold}`,
        producesFactKey: criterion.metric,
      };
    case "requirement-satisfied":
      return {
        ...base,
        id: taskId(phaseKey, criterion.id, "satisfy-requirement"),
        kind: "satisfy-requirement",
        title: `Satisfy requirement "${criterion.requirementId}"`,
        producesFactKey: null,
      };
    case "phase-completed":
      return {
        ...base,
        id: taskId(phaseKey, criterion.id, "complete-phase"),
        kind: "complete-phase",
        title: `Complete phase "${criterion.phaseId}" first`,
        producesFactKey: null,
      };
    default:
      return {
        ...base,
        id: taskId(phaseKey, criterion.id, "run-validator"),
        kind: "run-validator",
        title: `Pass validator "${criterion.customValidator}"`,
        producesFactKey: null,
      };
  }
}

/**
 * At most TWO tasks per blocker, and the cap is deliberate: a task lane with
 * five near-duplicate cards per gap is the same as no task lane, because the
 * founder stops reading it. The two are "the question that closes this" and
 * "the target that satisfies this", which are genuinely different moves.
 *
 * NOTE the branch for uncertain blockers. When the gate could not assess a
 * criterion we do NOT emit the criterion-typed target task, because "establish
 * fact X" asserts that fact X is missing — and we do not know that. All we know
 * is that the gate could not read it, so the only honest task is to supply
 * evidence. Emitting the confident task here would be the canvas inventing a
 * gap the gate never found.
 */
function buildTasks(
  phaseKey: string,
  context: BlockerContext,
  severity: BlockerSeverity,
  blockerText: string
): UnblockingTask[] {
  const tasks: UnblockingTask[] = [];
  const criterionId = context.criterionId;

  const nextQuestion = context.evaluation?.nextQuestion?.trim();
  if (nextQuestion) {
    tasks.push({
      id: taskId(phaseKey, criterionId, "answer-question"),
      kind: "answer-question",
      title: `Answer: ${nextQuestion}`,
      detail: blockerText,
      criterionId,
      producesFactKey: null,
    });
  }

  if (severity === "unknown") {
    tasks.push({
      id: taskId(phaseKey, criterionId, "supply-evidence"),
      kind: "supply-evidence",
      title: `Supply evidence for "${criterionId}"`,
      detail: context.criterion?.description ?? blockerText,
      criterionId,
      producesFactKey: null,
    });
    return tasks;
  }

  if (context.criterion !== undefined) {
    tasks.push(criterionTargetTask(phaseKey, context.criterion));
    return tasks;
  }

  // Unreachable while resolveSeverity() returns "unknown" for every context
  // without a criterion — kept because a blocker with no task at all is a dead
  // end on the canvas, and this is cheaper than trusting that invariant.
  tasks.push({
    id: taskId(phaseKey, criterionId, "close-gap"),
    kind: "close-gap",
    title: `Close the gap: ${blockerText}`,
    detail: blockerText,
    criterionId,
    producesFactKey: null,
  });
  return tasks;
}

/**
 * Every criterion worth reporting on, in ONE list: the phase's own criteria
 * (whether or not the judge covered them) plus anything the judge returned that
 * the phase does not define.
 *
 * Uncovered criteria are included rather than skipped because gate.ts's
 * fail-closed paths — failClosedVerdict(), the coverage-mismatch branch — emit
 * a BLOCK verdict with a `perCriterion` array that is short or empty. Skipping
 * what the judge did not mention would render those verdicts as an EMPTY
 * blocker list, i.e. a blocked phase that looks clear. That is the exact
 * "silence reads as success" failure fail-closed forbids.
 */
function collectContexts(input: AnalyzeBlockersInput): BlockerContext[] {
  const { criteria, verdict } = input;
  const evaluations = new Map<string, CriterionEvaluation>();
  for (const evaluation of verdict?.perCriterion ?? []) {
    // First writer wins. gate.ts BLOCKs on duplicate ids, so a verdict with
    // duplicates is already a failure; picking one arbitrarily would make the
    // canvas non-deterministic on top of that.
    if (!evaluations.has(evaluation.criterionId)) {
      evaluations.set(evaluation.criterionId, evaluation);
    }
  }

  const contexts: BlockerContext[] = criteria.map((criterion, index) => ({
    criterionId: criterion.id,
    criterion,
    evaluation: evaluations.get(criterion.id),
    order: index,
  }));

  const defined = new Set(criteria.map((c) => c.id));
  let extra = criteria.length;
  for (const evaluation of evaluations.values()) {
    if (defined.has(evaluation.criterionId)) {
      continue;
    }
    contexts.push({
      criterionId: evaluation.criterionId,
      criterion: undefined,
      evaluation,
      order: extra,
    });
    extra += 1;
  }

  return contexts;
}

/**
 * Whether the phase is refused advance, as a function of the DECISION and the
 * criterion's severity — not of severity alone.
 *
 * The gate is the only authority on advance. A WARN verdict has already
 * permitted the founder through, so nothing inside it "blocks", however
 * severely the phase declares that criterion. Deriving this from severity alone
 * would let the canvas show a red "blocks advance" flag on a phase the gate is
 * actively waving through — a contradiction the founder cannot resolve.
 */
function resolveBlocksAdvance(
  decision: GateVerdict["decision"],
  criterion: ExitCriterion | undefined
): boolean {
  if (decision !== "BLOCK") {
    return false;
  }
  // Fail closed on an unknown criterion, exactly as gate.ts does with
  // `severityOf.get(e.criterionId) ?? "blocking"`.
  return criterion === undefined || criterion.severity === "blocking";
}

function resolveState(
  decision: GateVerdict["decision"],
  blockerCount: number
): BlockerAnalysisState {
  if (decision === "BLOCK") {
    return "blocked";
  }
  if (decision === "WARN") {
    return "advisory";
  }
  // PASS. "clear" only when there is genuinely nothing outstanding — a PASS
  // produced by `gate.enabled: false` can still carry unchecked criteria, and
  // reporting that as "clear" would hide an operator opt-out behind a green
  // badge.
  return blockerCount === 0 ? "clear" : "advisory";
}

/**
 * THE PURE ENTRY POINT. GateVerdict → { blocker, severity, unblocking_task[] }.
 *
 * Fail-closed rules, all of them visible above:
 *  1. no verdict          ⇒ "unassessed", zero blockers, never "blocked".
 *  2. criterion uncovered ⇒ a blocker at severity "unknown", never omitted.
 *  3. no gap named        ⇒ severity "unknown", never "blocking" and never met.
 *  4. unknown criterion   ⇒ severity "unknown", blocksAdvance true under BLOCK.
 *  5. uncertainty         ⇒ "supply evidence", never a confident fix-it task.
 */
export function analyzeBlockers(input: AnalyzeBlockersInput): BlockerAnalysis {
  const { phaseKey, verdict } = input;

  // RULE 1. The whole reason this function does not just take a decision.
  if (verdict === null) {
    return {
      state: "unassessed",
      decision: null,
      blockers: [],
      tasks: [],
      reason: null,
    };
  }

  const contexts = collectContexts(input);
  const blockers: Blocker[] = [];
  for (const context of contexts) {
    if (context.evaluation?.status === "met") {
      continue;
    }
    const severity = resolveSeverity(context);
    const blockerText = resolveBlockerText(context);
    blockers.push({
      id: `${phaseKey}::${context.criterionId}`,
      criterionId: context.criterionId,
      blocker: blockerText,
      severity,
      blocksAdvance: resolveBlocksAdvance(verdict.decision, context.criterion),
      // An absent evaluation is not evaluable by definition — there is nothing
      // to have evaluated it.
      status: context.evaluation?.status ?? "not-evaluable",
      unblockingTasks: buildTasks(phaseKey, context, severity, blockerText),
    });
  }

  // Sort AFTER building, on (severity, definition order), never on judge order.
  const orderOf = new Map(contexts.map((c) => [c.criterionId, c.order]));
  blockers.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    return (
      (orderOf.get(a.criterionId) ?? 0) - (orderOf.get(b.criterionId) ?? 0)
    );
  });

  // Flatten, deduplicating by id. Task ids embed the criterion id, so this only
  // fires when the phase definition itself contains a duplicated criterion id.
  // definitions.test.ts asserts they are unique, but this module is handed an
  // ExitCriterion[] by a caller and does not get to assume the caller checked —
  // and duplicate React keys silently drop siblings rather than erroring.
  const tasks: UnblockingTask[] = [];
  const seenTaskIds = new Set<string>();
  for (const blocker of blockers) {
    for (const task of blocker.unblockingTasks) {
      if (seenTaskIds.has(task.id)) {
        continue;
      }
      seenTaskIds.add(task.id);
      tasks.push(task);
    }
  }

  return {
    state: resolveState(verdict.decision, blockers.length),
    decision: verdict.decision,
    blockers,
    tasks,
    reason: verdict.reason,
  };
}
