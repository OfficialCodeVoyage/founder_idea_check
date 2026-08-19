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

const criterionBase = {
  id: z.string().regex(CRITERION_ID_PATTERN),
  description: z.string().min(10),
  severity: z.enum(CRITERION_SEVERITIES).default("blocking"),
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
 * Shape borrowed from QuintinBotes/warden's GateDecision (MIT, @2736c2b):
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
});

export type GateVerdict = z.infer<typeof GateVerdictSchema>;

/** A fact as stored / as read back into a prompt. */
export const KnownFactSchema = z.object({
  key: z.string().regex(FACT_KEY_PATTERN),
  value: z.string().min(1),
  confidence: z.number().int().min(0).max(100),
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
