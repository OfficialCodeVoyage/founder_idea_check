import {
  PHASE_EIGHT,
  PHASE_FIVE,
  PHASE_SEVEN,
  PHASE_SIX,
} from "./definitions-delivery";
import { PHASE_FOUR, PHASE_THREE, PHASE_TWO } from "./definitions-discovery";
import {
  type ExitCriterion,
  GateConfigSchema,
  type PhaseDefinition,
  PhaseDefinitionSchema,
} from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EIGHT-PHASE SPLIT, AND WHY IT IS THIS SPLIT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The six-step arc this workflow re-implements is the well-trodden one: validate
 * the problem, shape a solution, name the user, verify demand, plan an MVP, go
 * to market. Every word of copy here and in prompts/phases/ is our own; only the
 * ORDER of the arc is common practice.
 *
 * We run eight gates, not six. Two insertions, each with a reason:
 *
 *  • PHASE 5, POSITIONING, is inserted BETWEEN demand verification and the MVP
 *    plan. Positioning decides what the product must be able to say about
 *    itself, and that constrains what the MVP has to prove. Scope a build before
 *    you can name the alternative you displace and you get a feature list, after
 *    which positioning degenerates into a description of whatever got built. The
 *    honesty-protocol anti-pattern "roadmap as positioning" is precisely the
 *    failure mode of running these two in the other order.
 *
 *  • PHASE 7, PRICING AND UNIT ECONOMICS, is inserted BETWEEN the MVP plan and
 *    go-to-market. It needs the MVP scope in order to price something concrete,
 *    and go-to-market needs the price before any channel arithmetic can close
 *    (payback is meaningless without one). It is its own gate rather than a
 *    paragraph inside go-to-market because "we'll monetise later" is a named
 *    anti-pattern in the persona, and a paragraph inside another phase is exactly
 *    how it gets skipped.
 *
 * We deliberately do NOT open with a separate "idea intake / brainstorm" phase.
 * A gate whose exit criterion is "the founder has described an idea" can never
 * refuse, and a gate that never refuses teaches the founder that gates are
 * decoration — the one thing this product cannot afford. Intake is the opening
 * move of phase 1 instead (prompts/phases/phase-01-problem.md).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INVARIANTS EVERY PHASE HOLDS (all asserted in definitions.test.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  1. `factKeys` are DISJOINT across phases. ProjectFact carries
 *     UNIQUE (projectId, key), so a key shared by two phases would let phase 7
 *     silently overwrite a phase 1 fact through the same upsert conflict target.
 *     Where a later phase builds on an earlier fact it REFERS to it in prose —
 *     the whole fact store is rendered into every gate prompt — and stores its
 *     own conclusion under its own key.
 *
 *  2. Every `artifact-exists.factKey` and every `metric-threshold.metric` is a
 *     member of that phase's `factKeys`. Otherwise the extractor — vocabulary
 *     restricted to factKeys by sanitizeFacts() in extract.ts — can never write
 *     the fact the criterion demands, and the gate blocks on evidence the founder
 *     has no way to produce.
 *
 *  3. No criterion uses type `phase-completed` or `custom`. Both are in the
 *     borrowed vocabulary and both are unjudgeable here: the gate judge sees a
 *     transcript and a fact store, nothing else. Asking it to confirm from a
 *     transcript that a previous phase completed is a vibe check on data it does
 *     not have — sequencing is the runtime's job. `custom` names a validator
 *     function that does not exist.
 *
 *  4. Every criterion is CHECKABLE from the transcript plus the fact store: it
 *     names a fact, a number, or a specific artefact whose absence is visible.
 *     "Has a clear vision" is not a criterion. Where a criterion is a judgement,
 *     its description states what does NOT satisfy it, so the judge applies a
 *     rule rather than matching a mood.
 *
 *  5. `gate` is GateConfigSchema.parse({}) for all eight — tolerateBlockingPartials
 *     0 (a blocking criterion sitting at "partial" BLOCKS) and minFactsRequired 1.
 *     minFactsRequired is deliberately NOT ramped per phase: the gate counts facts
 *     PROJECT-WIDE, so a per-phase threshold would be a proxy that drifts with how
 *     chatty the extractor was earlier. Per-phase requirements belong in
 *     exitCriteria, where the judge can name the gap it found.
 *
 * Phase 1 is defined below; phases 2-4 live in ./definitions-discovery and 5-8 in
 * ./definitions-delivery, purely to keep each file readable. Phase 1 sits here
 * rather than with the others because PHASE_ONE is the one definition other
 * modules import by name (runtime.ts, phase.router.ts), and re-exporting an
 * imported binding is a lint error in both available spellings
 * (noExportedImports vs noBarrelFile). Everything else should reach the phases
 * through PHASES / getPhaseByKey / getPhaseByOrder.
 */

/**
 * Phase 1 exit criteria, derived from the kill rubric vendored at
 * apps/chat/prompts/persona/problem-validation-rubric.md
 * (assimovt/productskills @ 66f9cee, MIT).
 *
 * The rubric is not a single number. Its Go/No-Go section defines kill triggers
 * that fire INDEPENDENTLY of the score — "nobody has tried to solve it
 * themselves" and "willingness to pay is entirely hypothetical" are Kill even
 * at a passing score. Those two are modelled here as their own BLOCKING
 * criteria (existing-workarounds, willingness-to-pay) rather than folded into
 * validation-score, which is exactly the thing a single threshold gets wrong.
 *
 * THRESHOLD CHOICE, flagged: validation-score is gated at >= 100, the bottom of
 * the rubric's "Promising / investigate more" band, NOT at 250 ("Strong signal.
 * Build."). Exiting phase 1 means "this problem is worth investigating
 * further", not "build it"; 250 is the bar for a later phase. The constants 100
 * and 250 are used verbatim — 249 and 96 are not achievable products of four
 * 1-5 integers.
 *
 * "You've talked to 5+ people" is the rubric's Investigate trigger, not a Kill
 * trigger, so people-interviewed is severity "advisory" — it produces WARN, not
 * BLOCK.
 */
const PHASE_ONE_CRITERIA: ExitCriterion[] = [
  {
    id: "problem-statement",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "problem_statement",
    description:
      "A specific problem is stated as something a named person experiences, not as a product idea or a market category.",
  },
  {
    id: "target-user",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "target_user",
    description:
      "A specific buyer or user segment is named — a role and a context, not 'small businesses' or 'everyone'.",
  },
  {
    id: "frequency-and-intensity",
    type: "requirement-satisfied",
    severity: "blocking",
    requirementId: "rubric.frequency-and-intensity",
    description:
      "How often the problem occurs and how much it costs when it does are both evidenced from past behaviour, each scoreable 1-5 on the rubric.",
  },
  {
    id: "existing-workarounds",
    type: "requirement-satisfied",
    severity: "blocking",
    requirementId: "rubric.workarounds",
    description:
      "At least one concrete workaround people already use is described. No workaround at all is an explicit kill: the problem is not painful enough to build for.",
  },
  {
    id: "willingness-to-pay",
    type: "requirement-satisfied",
    severity: "blocking",
    requirementId: "rubric.willingness-to-pay",
    description:
      "Willingness to pay is evidenced by money already spent or a number someone named. Purely hypothetical willingness ('they would probably pay') does not satisfy this.",
  },
  {
    id: "evidence-quality",
    type: "requirement-satisfied",
    severity: "blocking",
    requirementId: "rubric.evidence",
    description:
      "Every dimension cites evidence of a type the rubric accepts: observed behaviour, spending, time invested, or interview quotes. Surveys and 'a friend said' alone do not satisfy this.",
  },
  {
    id: "validation-score",
    type: "metric-threshold",
    severity: "blocking",
    metric: "validation_score",
    operator: "≥",
    threshold: 100,
    description:
      "Frequency x Intensity x Workarounds x Willingness-to-pay, each scored 1-5, must reach 100. Below 100 the rubric says walk away or reframe the problem.",
  },
  {
    id: "people-interviewed",
    type: "metric-threshold",
    severity: "advisory",
    metric: "people_interviewed",
    operator: "≥",
    threshold: 5,
    description:
      "At least five people in the target segment have independently described the same problem. Fewer is not fatal here, but it means the finding is unconfirmed.",
  },
];

export const PHASE_ONE: PhaseDefinition = PhaseDefinitionSchema.parse({
  key: "problem-validation",
  order: 1,
  title: "Problem validation",
  goal: "Establish that a specific person has a specific, frequent, painful problem they already spend money or time working around.",
  promptFile: "phases/phase-01-problem.md",
  factKeys: [
    "problem_statement",
    "target_user",
    "problem_frequency",
    "problem_intensity",
    "existing_workarounds",
    "willingness_to_pay",
    "evidence_type",
    "people_interviewed",
    "validation_score",
  ],
  exitCriteria: PHASE_ONE_CRITERIA,
  gate: GateConfigSchema.parse({}),
});

/** Ordered 1..8. Index is not the contract — always read `.order`. */
export const PHASES: PhaseDefinition[] = [
  PHASE_ONE,
  PHASE_TWO,
  PHASE_THREE,
  PHASE_FOUR,
  PHASE_FIVE,
  PHASE_SIX,
  PHASE_SEVEN,
  PHASE_EIGHT,
];

export const FIRST_PHASE_KEY = PHASE_ONE.key;

export function getPhaseByKey(key: string): PhaseDefinition | undefined {
  return PHASES.find((p) => p.key === key);
}

export function getPhaseByOrder(order: number): PhaseDefinition | undefined {
  return PHASES.find((p) => p.order === order);
}

/** The phase after `key`, or undefined at the end of the workflow. */
export function getNextPhase(key: string): PhaseDefinition | undefined {
  const current = getPhaseByKey(key);
  if (!current) {
    return undefined;
  }
  return getPhaseByOrder(current.order + 1);
}
