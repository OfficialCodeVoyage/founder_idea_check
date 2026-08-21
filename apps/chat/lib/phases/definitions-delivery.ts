import {
  type ExitCriterion,
  GateConfigSchema,
  type PhaseDefinition,
  PhaseDefinitionSchema,
} from "./types";

/**
 * Phases 5-8 — the delivery half of the workflow: what you claim, what you
 * build, what it costs to buy, and how the first customers arrive.
 *
 * Imports ONLY ./types (which imports only zod). Same testability discipline as
 * types/gate/extract: no @/lib/db/*, no @/lib/ai/*. See definitions.ts for the
 * eight-phase split rationale and the invariants every phase here holds.
 */

/**
 * Phase 5 — Positioning and differentiation. (Our insertion into the six-step
 * arc; the reasoning is in definitions.ts.)
 *
 * Three of these criteria are honesty-protocol anti-patterns turned into gates,
 * because prose in a system prompt is advice and a gate is a rule:
 *  • "There's no competition"   → competitive-set (must include doing nothing)
 *  • "Dismissing the incumbent" → incumbent-strength
 *  • "Roadmap as positioning"   → differentiation-ships-today
 */
const PHASE_FIVE_CRITERIA: ExitCriterion[] = [
  {
    id: "positioning-statement",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "positioning_statement",
    description:
      "One sentence naming the phase 3 persona, the trigger, the category the buyer will file this under, the benefit, and the alternative it is chosen instead of.",
  },
  {
    id: "competitive-set",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "competitive_set",
    description:
      "At least three named alternatives the persona could pick instead, one of which must be doing nothing or the manual workaround from phase 1. 'There is no competition' does not satisfy this.",
  },
  {
    id: "primary-alternative",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "primary_alternative",
    description:
      "Which one of those alternatives the persona would actually choose today, singular. This is the thing the product has to beat.",
  },
  {
    id: "differentiation-claim",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "differentiation_claim",
    description:
      "The single reason this persona switches from that alternative, stated as a claim that could be false. A claim no competitor would dispute is not a differentiator.",
  },
  {
    id: "differentiation-ships-today",
    type: "requirement-satisfied",
    severity: "blocking",
    closure: "in-conversation",
    requirementId: "positioning.ships-today",
    description:
      "The differentiator is something the product will do in the MVP about to be planned. A roadmap item, a funding round or a future integration does not satisfy this.",
  },
  {
    id: "proof-of-claim",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "proof_of_claim",
    description:
      "Something a sceptical prospect can check for themselves — a demo, a benchmark with its method, a named reference customer, or a guarantee with terms. Adjectives are not proof.",
  },
  {
    id: "incumbent-strength",
    type: "requirement-satisfied",
    severity: "blocking",
    closure: "in-conversation",
    requirementId: "positioning.incumbent-strength",
    description:
      "States what the leading alternative does WELL and why its customers chose it. An answer that only lists the incumbent's failings does not satisfy this.",
  },
  {
    id: "top-objection",
    type: "artifact-exists",
    severity: "advisory",
    closure: "offline-only",
    factKey: "objection_and_answer",
    description:
      "The objection this persona raises first, and the answer, in the words a prospect would actually use.",
  },
  {
    id: "category-frame",
    type: "artifact-exists",
    severity: "advisory",
    closure: "in-conversation",
    factKey: "category_frame",
    description:
      "The existing budget line or tool category the buyer files this under. Inventing a new category is allowed, but then say who pays for it out of which budget.",
  },
];

export const PHASE_FIVE: PhaseDefinition = PhaseDefinitionSchema.parse({
  key: "positioning",
  order: 5,
  title: "Positioning and differentiation",
  goal: "State who this is for, what it is chosen instead of, and the one checkable reason they switch — against what ships, not what is planned.",
  promptFile: "phases/phase-05-positioning.md",
  factKeys: [
    "positioning_statement",
    "competitive_set",
    "primary_alternative",
    "differentiation_claim",
    "proof_of_claim",
    "category_frame",
    "objection_and_answer",
  ],
  exitCriteria: PHASE_FIVE_CRITERIA,
  gate: GateConfigSchema.parse({}),
});

/**
 * Phase 6 — MVP scope and build plan.
 *
 * THRESHOLD CHOICE, flagged: build-window is a `≤` on weeks — the only criterion
 * in the workflow that gets stricter as the number gets smaller. Eight weeks is
 * the point past which the plan stops being a test and becomes a product bet:
 * beyond it the phase 2 riskiest assumption stays untested for a whole quarter
 * and the phase 4 commitments go cold. If the scope does not fit, the answer is
 * to cut scope, not to raise the number.
 */
const PHASE_SIX_CRITERIA: ExitCriterion[] = [
  {
    id: "core-flow",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "mvp_core_flow",
    description:
      "One end-to-end flow, step by step, from the trigger event to the moment the user gets the value. A feature list is not a flow.",
  },
  {
    id: "included-features",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "mvp_included_features",
    description:
      "The list of what is being built, every item of which appears in that core flow. An item that serves no step of the flow belongs on the cut list.",
  },
  {
    id: "cut-list",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "mvp_excluded_features",
    description:
      "An explicit not-in-v1 list that includes at least one thing the founder wants to build. A cut list with nothing painful on it has not been cut.",
  },
  {
    id: "tests-riskiest-assumption",
    type: "requirement-satisfied",
    severity: "blocking",
    closure: "in-conversation",
    requirementId: "mvp.tests-riskiest-assumption",
    description:
      "The build is aimed at the riskiest assumption recorded in phase 2, and the plan says which observed result would count as that assumption being false.",
  },
  {
    id: "success-metric",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "mvp_success_metric",
    description:
      "One behavioural metric — a repeated action by a real user, or revenue. Signups, downloads, waitlist size and page views do not satisfy this.",
  },
  {
    id: "success-threshold",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "mvp_success_threshold",
    description:
      "A number and a date for that metric, committed to before the build starts.",
  },
  {
    id: "build-window",
    type: "metric-threshold",
    severity: "blocking",
    closure: "in-conversation",
    metric: "mvp_build_weeks",
    operator: "≤",
    threshold: 8,
    description:
      "The plan fits in eight weeks of the team that actually exists. Longer is a product plan, not an MVP — cut scope rather than extend the window.",
  },
  {
    id: "first-users-named",
    type: "metric-threshold",
    severity: "blocking",
    closure: "offline-only",
    metric: "mvp_named_first_users",
    operator: "≥",
    threshold: 3,
    description:
      "At least three real people, named, who have already agreed to use it — drawn from the phase 4 commitments. 'We will find users' does not satisfy this.",
  },
  {
    id: "manual-before-automated",
    type: "artifact-exists",
    severity: "advisory",
    closure: "in-conversation",
    factKey: "mvp_manual_parts",
    description:
      "The parts that will be done by hand at first instead of built, and the point at which each stops scaling.",
  },
];

export const PHASE_SIX: PhaseDefinition = PhaseDefinitionSchema.parse({
  key: "mvp-scope",
  order: 6,
  title: "MVP scope and build plan",
  goal: "Scope the smallest thing that reaches a named real user inside eight weeks and settles the riskiest assumption, with the success number set in advance.",
  promptFile: "phases/phase-06-mvp.md",
  factKeys: [
    "mvp_core_flow",
    "mvp_included_features",
    "mvp_excluded_features",
    "mvp_success_metric",
    "mvp_success_threshold",
    "mvp_build_weeks",
    "mvp_named_first_users",
    "mvp_manual_parts",
  ],
  exitCriteria: PHASE_SIX_CRITERIA,
  gate: GateConfigSchema.parse({}),
});

/**
 * Phase 7 — Pricing and unit economics. (Our second insertion; see
 * definitions.ts.)
 *
 * The rubric's Willingness-to-pay dimension is where phase 1 accepted "already
 * spending money on partial solutions" as the top score. This phase spends that
 * evidence: price-evidence requires the price to be anchored to money phase 1
 * established is already moving, or to a published competitor price, or to a
 * number a real prospect said out loud — the same "past behaviour, not opinion"
 * rule one level up.
 *
 * THRESHOLD CHOICE, flagged: payback-window is `≤ 12` months. A payback longer
 * than a year has to be financed by someone, and a founder who has not shown
 * that financing is describing a business they cannot run. The number is a
 * convention rather than a law — but it is stated here instead of left to the
 * judge's mood, which is the whole point of a metric-threshold criterion.
 */
const PHASE_SEVEN_CRITERIA: ExitCriterion[] = [
  {
    id: "value-metric",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "pricing_value_metric",
    description:
      "What the price scales with — seats, runs, documents, transaction value — and why that unit tracks the value the persona receives.",
  },
  {
    id: "price-point",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "price_point",
    description:
      "An actual number, a currency and a billing period. 'Freemium', 'usage-based' or 'we will figure it out after launch' do not satisfy this.",
  },
  {
    id: "payer-named",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "payer_role",
    description:
      "The budget holder from the phase 3 buying process, and the budget line the money comes out of. Where the user and the payer differ, both are named.",
  },
  {
    id: "price-evidence",
    type: "requirement-satisfied",
    severity: "blocking",
    closure: "in-conversation",
    requirementId: "pricing.anchored-not-guessed",
    description:
      "The price is anchored to money already moving: what the persona pays for the workaround today, a competitor's published price, or a figure a real prospect named. A price derived only from desired revenue does not satisfy this.",
  },
  {
    id: "unit-economics",
    type: "requirement-satisfied",
    severity: "blocking",
    closure: "in-conversation",
    requirementId: "pricing.unit-economics-stated",
    description:
      "Cost to acquire a customer, gross margin and expected lifetime value are each given as a number with its assumptions labelled [Estimate]. An unlabelled figure fails this.",
  },
  {
    id: "payback-window",
    type: "metric-threshold",
    severity: "blocking",
    closure: "in-conversation",
    metric: "cac_payback_months",
    operator: "≤",
    threshold: 12,
    description:
      "Acquisition cost is repaid by gross profit within twelve months. Longer requires capital the founder must show they have.",
  },
  {
    id: "breakeven-math",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "breakeven_customers",
    description:
      "How many customers at this price cover the founder's stated monthly costs, counted bottom-up. A percentage of a market size does not satisfy this.",
  },
  {
    id: "pessimistic-case",
    type: "requirement-satisfied",
    severity: "advisory",
    closure: "in-conversation",
    requirementId: "pricing.survives-pessimistic-case",
    description:
      "The same arithmetic re-run with conversion halved and acquisition cost doubled, with the resulting verdict stated out loud.",
  },
];

export const PHASE_SEVEN: PhaseDefinition = PhaseDefinitionSchema.parse({
  key: "pricing-economics",
  order: 7,
  title: "Pricing and unit economics",
  goal: "Name who pays, how much, on what basis, and show the arithmetic that makes this a business rather than a hobby.",
  promptFile: "phases/phase-07-pricing.md",
  factKeys: [
    "pricing_model",
    "pricing_value_metric",
    "price_point",
    "payer_role",
    "gross_margin_pct",
    "cac_estimate",
    "ltv_estimate",
    "cac_payback_months",
    "breakeven_customers",
  ],
  exitCriteria: PHASE_SEVEN_CRITERIA,
  gate: GateConfigSchema.parse({}),
});

/**
 * Phase 8 — Go-to-market and launch.
 *
 * The last gate is the only one that can look back at every fact in the store,
 * so its hardest criterion is arithmetic rather than description:
 * channel-math-closes has to reconcile the phase 3 reachable audience, the phase
 * 4 conversion evidence and the phase 7 price into a number of customers, and
 * that number has to clear the phase 7 payback window. Two channels make that
 * arithmetic unfalsifiable, which is why single-channel is blocking.
 *
 * launch-kill-rule is blocking and deliberately last: a founder who will not
 * write down what result means stop has not made a plan, they have made a wish.
 */
const PHASE_EIGHT_CRITERIA: ExitCriterion[] = [
  {
    id: "single-channel",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "primary_channel",
    description:
      "ONE primary channel, named, reaching the phase 3 persona where they already are. A list of four channels to try does not satisfy this.",
  },
  {
    id: "channel-rationale",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "channel_rationale",
    description:
      "Why that channel and not the others, argued from where the persona was found in phase 3 and where the phase 4 respondents came from.",
  },
  {
    id: "repeatable-motion",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "gtm_motion",
    description:
      "The steps from stranger to paying customer, with who performs each step and how many times a week the team that exists can repeat it.",
  },
  {
    id: "first-ten-plan",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "first_ten_plan",
    description:
      "A deliberately unscalable plan for the first ten customers — specific people, accounts or communities by name — kept separate from the scalable channel.",
  },
  {
    id: "channel-math-closes",
    type: "requirement-satisfied",
    severity: "blocking",
    closure: "in-conversation",
    requirementId: "gtm.channel-math-closes",
    description:
      "Audience reachable per month, times the conversion evidenced in phase 4, times the phase 7 price, produces a customer and a revenue number; every assumption is labelled [Estimate] and the implied acquisition cost clears the phase 7 payback window.",
  },
  {
    id: "launch-target",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "launch_target",
    description:
      "A number and a date, set before launch: paying customers or revenue by a given day.",
  },
  {
    id: "launch-kill-rule",
    type: "artifact-exists",
    severity: "blocking",
    closure: "in-conversation",
    factKey: "gtm_kill_rule",
    description:
      "What result at that date means stop, and what result means change channel, written down now rather than decided afterwards.",
  },
  {
    id: "channel-already-tested",
    type: "metric-threshold",
    severity: "advisory",
    closure: "offline-only",
    metric: "gtm_channel_test_count",
    operator: "≥",
    threshold: 1,
    description:
      "At least one cheap test of this channel has already been run, so the conversion figure in the arithmetic is observed rather than assumed.",
  },
  {
    id: "no-vanity-target",
    type: "requirement-satisfied",
    severity: "advisory",
    closure: "in-conversation",
    requirementId: "gtm.no-vanity-metrics",
    description:
      "The launch target is revenue, paying customers or repeat usage. Signups, downloads, waitlist size, impressions and press mentions are not targets.",
  },
];

export const PHASE_EIGHT: PhaseDefinition = PhaseDefinitionSchema.parse({
  key: "go-to-market",
  order: 8,
  title: "Go-to-market and launch",
  goal: "Commit to one channel, one repeatable motion, a launch number with a date, and the rule that says when to stop.",
  promptFile: "phases/phase-08-gtm.md",
  factKeys: [
    "primary_channel",
    "channel_rationale",
    "gtm_motion",
    "first_ten_plan",
    "gtm_channel_cac",
    "gtm_channel_test_count",
    "launch_target",
    "gtm_kill_rule",
  ],
  exitCriteria: PHASE_EIGHT_CRITERIA,
  gate: GateConfigSchema.parse({}),
});
