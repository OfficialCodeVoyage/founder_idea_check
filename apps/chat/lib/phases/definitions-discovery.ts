import {
  type ExitCriterion,
  GateConfigSchema,
  type PhaseDefinition,
  PhaseDefinitionSchema,
} from "./types";

/**
 * Phases 2-4 — the rest of the discovery half of the workflow: what removes the
 * problem, who exactly has it, and whether strangers will pay before it exists.
 * Phase 1 lives in definitions.ts, next to the workflow header, because it is the
 * only phase other modules import by name.
 *
 * Imports ONLY ./types (which imports only zod). Same testability discipline as
 * types/gate/extract: no @/lib/db/*, no @/lib/ai/*. See definitions.ts for the
 * eight-phase split rationale and the invariants every phase here holds.
 */

/**
 * Phase 2 — Solution shaping.
 *
 * Still grounded in the vendored kill rubric, one step downstream. The rubric's
 * load-bearing claim is that the WORKAROUND is the proxy for pain: "If nobody
 * has attempted a workaround, the problem isn't painful enough to build for."
 * The corollary, which this phase gates on, is that a solution which does not
 * displace the workaround recorded in phase 1 is not a solution — it is a second
 * tool the user now has to run alongside the first. Hence displaces-workaround
 * and switching-cost are both blocking: the rubric scores Workarounds and
 * Willingness-to-pay highest when someone already spends money or time, and that
 * spend is precisely the budget and the habit a new product must take away from
 * something else.
 *
 * alternatives-considered is advisory, not blocking. Considering only one
 * approach is a real risk, but it is a process smell rather than evidence that
 * the solution is wrong — WARN is the honest register for it.
 */
const PHASE_TWO_CRITERIA: ExitCriterion[] = [
  {
    id: "solution-concept",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "solution_concept",
    description:
      "One sentence describing what the target user DOES differently once this exists. A feature list, a technology ('an AI agent that...') or a category name does not satisfy this.",
  },
  {
    id: "solution-mechanism",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "solution_mechanism",
    description:
      "The mechanism by which the pain is removed, stated end to end: what goes in, what the product does, what comes out. 'It uses AI' names a technology, not a mechanism.",
  },
  {
    id: "displaces-workaround",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "workaround_displaced",
    description:
      "Names the specific workaround established in phase 1 and states what the user STOPS doing. A solution that sits alongside the workaround instead of replacing it does not satisfy this.",
  },
  {
    id: "measurable-advantage",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "solution_advantage",
    description:
      "The improvement over that workaround expressed as a number on a dimension the user already measures — minutes per week, error rate, currency. Adjectives ('faster', 'seamless') do not satisfy this.",
  },
  {
    id: "switching-cost",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "switching_cost",
    description:
      "The concrete cost of moving off the current workaround — data to migrate, habits to retrain, a contract to exit — and why the stated gain is larger than it.",
  },
  {
    id: "riskiest-assumption",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "riskiest_assumption",
    description:
      "The single assumption that, if false, makes this solution not work, labelled [Assumption]. Not a list — the one that would kill it.",
  },
  {
    id: "assumption-test",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "assumption_test",
    description:
      "A test of that assumption that can be run without building the product, with its pass/fail result stated in advance.",
  },
  {
    id: "traces-to-problem",
    type: "requirement-satisfied",
    severity: "blocking",
    requirementId: "solution.traces-to-validated-problem",
    description:
      "Every capability described traces back to the problem statement and target user established in phase 1. Anything that does not is named as out of scope rather than justified.",
  },
  {
    id: "excluded-scope",
    type: "artifact-exists",
    severity: "advisory",
    factKey: "excluded_scope",
    description:
      "At least one capability the founder wants but is deliberately not building, with the reason. A solution with nothing excluded has not been shaped yet.",
  },
  {
    id: "alternatives-considered",
    type: "metric-threshold",
    severity: "advisory",
    metric: "alternatives_considered",
    operator: "≥",
    threshold: 2,
    description:
      "At least two materially different approaches to the same problem were considered, and the discarded one was discarded for a stated reason.",
  },
];

export const PHASE_TWO: PhaseDefinition = PhaseDefinitionSchema.parse({
  key: "solution-shaping",
  order: 2,
  title: "Solution shaping",
  goal: "Define the smallest intervention that removes the validated problem, name what it displaces, and name the one assumption that would kill it.",
  promptFile: "phases/phase-02-solution.md",
  factKeys: [
    "solution_concept",
    "solution_mechanism",
    "workaround_displaced",
    "solution_advantage",
    "switching_cost",
    "riskiest_assumption",
    "assumption_test",
    "excluded_scope",
    "alternatives_considered",
  ],
  exitCriteria: PHASE_TWO_CRITERIA,
  gate: GateConfigSchema.parse({}),
});

/**
 * Phase 3 — User personas.
 *
 * STRICTNESS RAMP, flagged: persona-interview-count is BLOCKING at 5, whereas
 * the same rubric line was ADVISORY in phase 1 (people-interviewed). That is
 * deliberate, and it is the rubric's own structure: "You've talked to fewer than
 * 5 people" sits under Investigate more, but "ALWAYS talk to at least 5 people in
 * the ICP before making a go/no-go call" is a hard guideline. Writing the persona
 * IS the go/no-go on who the company serves — every later phase inherits it — so
 * this is the point where the rubric's guideline becomes a gate.
 */
const PHASE_THREE_CRITERIA: ExitCriterion[] = [
  {
    id: "primary-persona",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "primary_persona",
    description:
      "One primary persona: a role, a context, and at least two OBSERVABLE attributes you could filter a list on (team size, tool already in use, job title). Psychographics like 'ambitious' do not satisfy this.",
  },
  {
    id: "single-beachhead",
    type: "requirement-satisfied",
    severity: "blocking",
    requirementId: "persona.single-beachhead",
    description:
      "Exactly one persona is chosen to go first and every other candidate segment is explicitly deprioritised with a reason. Two co-equal 'primary' personas do not satisfy this.",
  },
  {
    id: "trigger-event",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "persona_trigger_event",
    description:
      "The observable event that makes this persona start looking for a fix, stated as something that happened to a real person on a real day — not a state of mind.",
  },
  {
    id: "buying-process",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "buying_process",
    description:
      "Who chooses, who pays and who can veto, named as roles. 'The founder decides' is acceptable only if the persona is the founder of a company that small.",
  },
  {
    id: "budget-owner",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "budget_owner",
    description:
      "The role that controls the money, and whether the founder has ever spoken to someone in that role. No access to the budget owner is a yellow flag that must be stated, not omitted.",
  },
  {
    id: "persona-evidence",
    type: "requirement-satisfied",
    severity: "blocking",
    requirementId: "persona.grounded-in-evidence",
    description:
      "Each persona attribute is backed by a direct quote or an observed behaviour, or is labelled [Assumption]. An unlabelled invented attribute fails this criterion for the whole persona.",
  },
  {
    id: "persona-interview-count",
    type: "metric-threshold",
    severity: "blocking",
    metric: "persona_interviews_count",
    operator: "≥",
    threshold: 5,
    description:
      "At least five people matching this persona have been spoken to directly and their accounts converge. Fewer means the persona is a hypothesis, not a finding.",
  },
  {
    id: "excluded-segments",
    type: "artifact-exists",
    severity: "advisory",
    factKey: "excluded_segments",
    description:
      "At least one nearby segment that is explicitly NOT being served first, with the reason it was cut.",
  },
  {
    id: "reachable-channel",
    type: "artifact-exists",
    severity: "advisory",
    factKey: "persona_reachable_where",
    description:
      "A named place — community, list, event, publication, search term — where a hundred of these people can actually be reached. This is the input to phase 8.",
  },
];

export const PHASE_THREE: PhaseDefinition = PhaseDefinitionSchema.parse({
  key: "user-personas",
  order: 3,
  title: "User personas",
  goal: "Turn the target user into one primary persona defined by observable attributes, a trigger event and a buying process, with the segments you are not serving named.",
  promptFile: "phases/phase-03-personas.md",
  factKeys: [
    "primary_persona",
    "persona_trigger_event",
    "persona_current_stack",
    "buying_process",
    "budget_owner",
    "persona_reachable_where",
    "excluded_segments",
    "persona_interviews_count",
  ],
  exitCriteria: PHASE_THREE_CRITERIA,
  gate: GateConfigSchema.parse({}),
});

/**
 * Phase 4 — Demand verification.
 *
 * The rubric's evidence ladder ranks spending and observed behaviour above
 * quotes, and quotes above surveys. This phase is where the founder climbs it:
 * phase 1 accepted interview quotes about the PAST, this phase demands a costly
 * signal about the future product from people who are not friends.
 *
 * THRESHOLD CHOICES, flagged. demand-sample-size >= 20 is the point below which a
 * zero result is indistinguishable from bad luck; it is a floor on the
 * DENOMINATOR, not a claim about the rate. demand-commitments >= 3 is the
 * numerator bar and it is the one that matters: three strangers who each paid
 * something is worth more than three hundred email addresses. conversion-rate is
 * ADVISORY at 5 percent precisely because the denominator is not comparable
 * across test designs — a 5% landing-page conversion and a 5% cold-outreach reply
 * are different animals, so it informs rather than decides.
 */
const PHASE_FOUR_CRITERIA: ExitCriterion[] = [
  {
    id: "demand-test-design",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "demand_test_design",
    description:
      "A named test that has actually been run — pre-sale, paid pilot, concierge delivery, deposit waitlist, cold outreach with a calendar ask — including the exact wording of the ask.",
  },
  {
    id: "demand-test-channel",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "demand_test_channel",
    description:
      "Where the respondents came from, named specifically enough that the same source could be used again.",
  },
  {
    id: "costly-signal",
    type: "requirement-satisfied",
    severity: "blocking",
    requirementId: "demand.costly-signal",
    description:
      "The signal counted cost the respondent something real: money, a scheduled meeting, an introduction, or their own data. Page views, likes, free email signups and 'I'd definitely use that' do not satisfy this.",
  },
  {
    id: "strangers-not-friends",
    type: "requirement-satisfied",
    severity: "blocking",
    requirementId: "demand.strangers-not-network",
    description:
      "Respondents came from outside the founder's personal network and match the phase 3 persona. Friends and colleagues are excluded from the count rather than explained away.",
  },
  {
    id: "pre-registered-threshold",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "demand_pass_threshold",
    description:
      "The pass/fail number was stated BEFORE the test ran and appears in the transcript before the result does. A threshold produced after seeing the outcome does not satisfy this.",
  },
  {
    id: "demand-sample-size",
    type: "metric-threshold",
    severity: "blocking",
    metric: "demand_test_sample_size",
    operator: "≥",
    threshold: 20,
    description:
      "At least twenty people in the persona were actually asked. Below that, a result of zero and a result of one are the same result.",
  },
  {
    id: "demand-commitments",
    type: "metric-threshold",
    severity: "blocking",
    metric: "demand_commitments_count",
    operator: "≥",
    threshold: 3,
    description:
      "At least three people gave a costly commitment — a payment, a deposit, a signed letter of intent, or a booked paid pilot.",
  },
  {
    id: "demand-verdict",
    type: "artifact-exists",
    severity: "blocking",
    factKey: "demand_verdict",
    description:
      "An explicit go / pivot / kill call made by comparing the actual result to the pre-registered threshold, including the case where the threshold was missed.",
  },
  {
    id: "conversion-rate",
    type: "metric-threshold",
    severity: "advisory",
    metric: "demand_conversion_rate",
    operator: "≥",
    threshold: 5,
    description:
      "Costly commitments as a percentage of people asked, at or above 5. Advisory only: the denominator is not comparable across test designs.",
  },
];

export const PHASE_FOUR: PhaseDefinition = PhaseDefinitionSchema.parse({
  key: "demand-verification",
  order: 4,
  title: "Demand verification",
  goal: "Get a costly signal from strangers that they want this before it exists, against a pass/fail number set before the test was run.",
  promptFile: "phases/phase-04-demand.md",
  factKeys: [
    "demand_test_design",
    "demand_test_channel",
    "demand_signal_type",
    "demand_pass_threshold",
    "demand_test_sample_size",
    "demand_commitments_count",
    "demand_conversion_rate",
    "demand_verdict",
  ],
  exitCriteria: PHASE_FOUR_CRITERIA,
  gate: GateConfigSchema.parse({}),
});
