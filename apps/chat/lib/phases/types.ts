import { z } from "zod";

/** Total phases in the planned workflow. Only phase 1 is implemented (Step 2). */
export const PHASE_COUNT = 8;

/**
 * Criterion vocabulary borrowed from codename-co/devs
 * (public/schemas/methodology.schema.json @ ce05b2c, MIT). Two deliberate
 * divergences from upstream:
 *  1. upstream sets required:["type"] with every discriminating field optional,
 *     so `metric-threshold` with no metric validates. We model it as a Zod
 *     discriminated union so each variant requires its own fields.
 *  2. upstream's `description` is optional. For an LLM-judged gate it is the
 *     field the judge actually reads, so it is required and min-length here.
 */
export const CRITERION_TYPES = [
  "artifact-exists",
  "requirement-satisfied",
  "metric-threshold",
  "phase-completed",
  "custom",
] as const;

export const COMPARISON_OPERATORS = ["<", "≤", ">", "≥", "==", "!="] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

/** Fact keys are snake_case so they can be interpolated into prompts safely. */
export const FACT_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
/** Criterion ids are kebab-case and appear verbatim in judge output. */
export const CRITERION_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;

/**
 * blocking  — an unmet criterion of this severity BLOCKS phase advance.
 * advisory  — an unmet criterion of this severity downgrades to WARN only.
 * This exists so "fewer than 5 people interviewed" (the rubric's
 * "Investigate more" trigger) is a WARN while "nobody has tried a workaround"
 * (the rubric's explicit Kill trigger) is a BLOCK, without relying on the
 * judge's discretion about `partial` vs `unmet`.
 */
export const CRITERION_SEVERITIES = ["blocking", "advisory"] as const;
export type CriterionSeverity = (typeof CRITERION_SEVERITIES)[number];

/**
 * HOW A CRITERION CAN BE CLOSED, which is a different question from whether it
 * is closed.
 *
 * in-conversation — the founder already knows this and has not said it. Asking
 *   for the value is the right move, and it is answerable this turn.
 * offline-only    — closing it needs field data that does not exist yet. Asking
 *   for the value is asking the founder to invent one.
 *
 * THIS EXISTS BECAUSE THE GATE DEADLOCKED ON IT. `problem-validation` demands
 * four evidence-backed rubric scores; a pre-revenue founder with zero
 * interviews got seven BLOCKs, and attempt 7's own nextQuestion asked them to
 * supply the four numbers. Four typed integers would have passed the phase. A
 * gate built to stop assumptions being laundered into evidence was asking for
 * one, and the founder — correctly — refused twice.
 *
 * DEFAULT IS `in-conversation`, and that is the fail-closed direction. A
 * criterion mislabelled in-conversation keeps today's behaviour: the gate asks
 * for the value. One mislabelled offline-only stops the gate asking for a value
 * it could legitimately have had. The stricter mistake is the default.
 */
export const CRITERION_CLOSURES = ["in-conversation", "offline-only"] as const;
export type CriterionClosure = (typeof CRITERION_CLOSURES)[number];

const criterionBase = {
  id: z.string().regex(CRITERION_ID_PATTERN),
  description: z.string().min(10),
  severity: z.enum(CRITERION_SEVERITIES).default("blocking"),
  closure: z.enum(CRITERION_CLOSURES).default("in-conversation"),
};

export const ExitCriterionSchema = z.discriminatedUnion("type", [
  z.object({
    ...criterionBase,
    type: z.literal("artifact-exists"),
    /**
     * DIVERGENCE from devs: upstream's `artifactType` names a document type.
     * In this slice the only artifact is a stored project fact, so the variant
     * names the fact key it requires. Rename to artifactType when documents
     * land.
     */
    factKey: z.string().regex(FACT_KEY_PATTERN),
  }),
  z.object({
    ...criterionBase,
    type: z.literal("requirement-satisfied"),
    requirementId: z.string().min(1),
  }),
  z.object({
    ...criterionBase,
    type: z.literal("metric-threshold"),
    metric: z.string().regex(FACT_KEY_PATTERN),
    operator: z.enum(COMPARISON_OPERATORS),
    threshold: z.number(),
  }),
  z.object({
    ...criterionBase,
    type: z.literal("phase-completed"),
    phaseId: z.string().min(1),
  }),
  z.object({
    ...criterionBase,
    type: z.literal("custom"),
    customValidator: z.string().min(1),
  }),
]);

export type ExitCriterion = z.infer<typeof ExitCriterionSchema>;

/**
 * Gate configuration. `enabled` / `autoRetry` / `maxRetries` and their defaults
 * are taken from devs' configuration.qualityGates. The last two are ours.
 */
export const GateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoRetry: z.boolean().optional(),
  maxRetries: z.number().int().min(0).default(2),
  /** Fewer stored facts than this ⇒ BLOCK. 0 disables the guard. */
  minFactsRequired: z.number().int().min(0).default(1),
  /** More blocking criteria at `partial` than this ⇒ WARN instead of PASS. */
  /**
   * How many BLOCKING criteria may sit at "partial" and still only WARN.
   *
   * Default 0: a blocking criterion that is merely partly evidenced BLOCKS.
   * This is the strictness of the whole product. The judge is an LLM choosing
   * freely between the labels "partial" and "unmet"; if "partial" were a way
   * through, every gate would be one word away from being advisory, and the
   * product would silently degrade into a chat wrapper with tabs.
   *
   * Raise this only with a deliberate, per-phase reason. It never yields PASS —
   * tolerated partials still WARN, so the gap stays visible.
   */
  tolerateBlockingPartials: z.number().int().min(0).default(0),
});

export type GateConfig = z.infer<typeof GateConfigSchema>;

export const PhaseDefinitionSchema = z.object({
  key: z.string().regex(CRITERION_ID_PATTERN),
  /** 1-based. Rendered as "Phase {order} of {PHASE_COUNT}". */
  order: z.number().int().min(1).max(PHASE_COUNT),
  title: z.string().min(1),
  goal: z.string().min(10),
  /** Path relative to apps/chat/prompts, loaded by runtime.ts. */
  promptFile: z.string().min(1),
  /** The only fact keys the extractor for this phase may write. */
  factKeys: z.array(z.string().regex(FACT_KEY_PATTERN)).min(1),
  exitCriteria: z.array(ExitCriterionSchema).min(1),
  gate: GateConfigSchema,
});

export type PhaseDefinition = z.infer<typeof PhaseDefinitionSchema>;

export const CRITERION_STATUSES = [
  "met",
  "partial",
  "unmet",
  /** The judge could not tell. Fails closed — never treated as met. */
  "not-evaluable",
] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

/**
 * JUDGE-FACING schema: lenient, all optional fields defaulted, NO cross-field
 * refinements. Refinements here would make a slightly-off model response throw
 * instead of failing closed with a readable reason. The invariants
 * ("a non-met status must name a gap") are enforced in gate.ts by
 * normalizeEvaluation(), which downgrades violations to `not-evaluable`.
 */
export const CriterionEvaluationSchema = z.object({
  criterionId: z.string().min(1),
  status: z.enum(CRITERION_STATUSES),
  /** Quote from the transcript or a `key=value` fact reference. */
  evidence: z.string().default(""),
  /** What specifically is missing. Required in practice for a non-met status. */
  gap: z.string().nullable().default(null),
  /** The one question that would close this gap. */
  nextQuestion: z.string().nullable().default(null),
  confidence: z.number().int().min(0).max(100).default(50),
});

export type CriterionEvaluation = z.infer<typeof CriterionEvaluationSchema>;

/** What the judge model returns. Passed to Output.object({ schema }). */
export const JudgeOutputSchema = z.object({
  evaluations: z.array(CriterionEvaluationSchema),
});

export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export const GATE_DECISIONS = ["PASS", "WARN", "BLOCK"] as const;
export type GateDecisionValue = (typeof GATE_DECISIONS)[number];

/**
 * WHAT STANDS IN THE WAY, as its own arm rather than as a headline over a list
 * of strings.
 *
 * `missing` is a flat array of sentences, so every non-PASS verdict rendered
 * identically: the card printed "WHAT IS MISSING" above text that said "could
 * not be assessed". Those are different states with different remedies — *the
 * gate could not judge this* versus *you have not done this* versus *this
 * cannot be known yet* — and a founder could not tell which one they were
 * looking at.
 *
 *  phase-misconfigured — the phase defines no criteria. A code bug, not a gap.
 *  judge-incomplete    — the judge returned nothing, duplicates, or the wrong
 *                        set. A plumbing failure wearing a refusal's clothes.
 *  no-facts-yet        — nothing is established about the project at all.
 *  not-evaluable       — the judge could not tell. NOT the same as unmet.
 *  evidence-missing    — a real gap the founder can close by answering.
 *  fieldwork-required  — every blocking gap needs data that does not exist yet.
 *                        STILL BLOCKS. What changes is the question asked.
 *  advisory-only       — blocking criteria are met; something soft is open.
 */
export const GATE_OBSTACLE_KINDS = [
  "phase-misconfigured",
  "judge-incomplete",
  "no-facts-yet",
  "not-evaluable",
  "evidence-missing",
  "fieldwork-required",
  "advisory-only",
] as const;
export type GateObstacleKind = (typeof GATE_OBSTACLE_KINDS)[number];

export const GateObstacleSchema = z.object({
  kind: z.enum(GATE_OBSTACLE_KINDS),
  /**
   * The criteria this obstacle is about, by id. Empty for the arms that are
   * about the gate rather than about the work (`phase-misconfigured`,
   * `judge-incomplete`, `no-facts-yet`).
   */
  criterionIds: z.array(z.string()).default([]),
});

export type GateObstacle = z.infer<typeof GateObstacleSchema>;

/**
 * Shape borrowed from QuintinBotes/warden's GateDecision (MIT, v0.4.1):
 * a three-valued verdict plus a REQUIRED human-readable reason naming the rule
 * that fired. Extended with the fields the UI and the next turn need.
 */
export const GateVerdictSchema = z.object({
  decision: z.enum(GATE_DECISIONS),
  perCriterion: z.array(CriterionEvaluationSchema),
  /** Ordered gap sentences. missing[0] is what the rail shows. */
  missing: z.array(z.string()),
  /** NULL only when decision === "PASS". */
  nextQuestion: z.string().nullable(),
  reason: z.string().min(1),
  /**
   * Which rule fired, as data. NULL on PASS — and DEFAULTED to null so that
   * every verdict already sitting in `ProjectPhaseAttempt.verdict` still
   * parses. Without the default, adding this field would have made the entire
   * refusal ledger read as `unreadable: true` — turning the product's own
   * history of refusals into "this verdict can no longer be read".
   */
  obstacle: GateObstacleSchema.nullable().default(null),
});

export type GateVerdict = z.infer<typeof GateVerdictSchema>;

/** A fact as stored / as read back into a prompt. */
export const KnownFactSchema = z.object({
  key: z.string().regex(FACT_KEY_PATTERN),
  value: z.string().min(1),
  confidence: z.number().int().min(0).max(100),
  /**
   * Who asserted this: the extractor, or the founder correcting it by hand.
   *
   * OPTIONAL, and the omission is deliberate rather than a defaulted unknown.
   * The gate's eval fixtures hold scores of hand-written KnownFact literals and
   * every one of them IS an extracted fact; making this required would churn
   * all of them to restate a default. Absence means "extracted", and the READ
   * PATH always supplies it explicitly, so absence can never originate from the
   * database — only from a literal that predates the column.
   */
  origin: z.enum(["extracted", "founder"]).optional(),
});

export type KnownFact = z.infer<typeof KnownFactSchema>;

export const ExtractedFactSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1).max(2000),
  confidence: z.number().int().min(0).max(100).default(50),
  /** Quote from the turn justifying the fact. Required — no evidence, no fact. */
  evidence: z.string().default(""),
});

export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

export const ExtractionOutputSchema = z.object({
  facts: z.array(ExtractedFactSchema).max(12),
});

export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

/** One turn of transcript, flattened to text for the judge. */
export type TranscriptTurn = {
  role: "user" | "assistant";
  text: string;
};
