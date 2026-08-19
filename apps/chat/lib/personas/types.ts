import { z } from "zod";
import { PHASE_THREE } from "@/lib/phases/definitions-discovery";
import type { ExitCriterion } from "@/lib/phases/types";

/**
 * THE PERSONA SCHEMA. Two schemas, on purpose, exactly as lib/phases does it.
 *
 *  - The MODEL-FACING half (`PersonaDraftSchema`) is deliberately LENIENT: every
 *    field is `.default()`ed, nothing is `.min()`ed and there is not one
 *    cross-field `.refine()`. A refinement here would make a slightly-off model
 *    response THROW instead of failing closed with a readable reason. Read the
 *    comment above `CriterionEvaluationSchema` in lib/phases/types.ts — same
 *    argument, same conclusion.
 *  - The STORED half (`PersonaSchema`) is where the invariants live, and they
 *    are enforced by the TYPE, not by a runtime check that a future refactor can
 *    delete: `evidence` on every value-bearing variant is a NON-EMPTY TUPLE
 *    (`[PersonaEvidence, ...PersonaEvidence[]]`). An attribute that asserts
 *    something about a human being WITHOUT a source is not "discouraged" or
 *    "validated against" — it does not typecheck and it cannot be constructed.
 *
 * That is the whole product in one sentence. A founder-facing tool whose persona
 * schema lets `evidence` be optional is a tool that will happily invent a
 * customer, and inventing a customer is the single failure this product exists
 * to prevent.
 *
 * DISCIPLINE (same as lib/phases/types.ts): imports zod and the phase
 * DEFINITIONS only. No "ai", no "@/lib/db/*", no "server-only", no clock, no
 * randomness. Every function reachable from this file runs under vitest with no
 * API key, no network and no database.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Coupling to phase 3, checked at import time.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FAIL LOUD ON DRIFT. Every constant below is pinned to a phase-3 exit criterion
 * or fact key by name. If someone renames `persona-interview-count`, the
 * alternative to throwing here is a persona module that silently stops enforcing
 * the interview floor while still rendering a confident persona card — the exact
 * class of silent degradation this codebase refuses. definitions-discovery.ts
 * already throws at import time (`PhaseDefinitionSchema.parse`), so this is the
 * established register for "the phase definition and the code disagree".
 */
function criterionOrThrow(id: string): ExitCriterion {
  const found = PHASE_THREE.exitCriteria.find((c) => c.id === id);
  if (!found) {
    throw new Error(
      `lib/personas is pinned to phase-3 exit criterion "${id}", which no longer exists in PHASE_THREE. Update PERSONA_ATTRIBUTE_SPECS (or the criterion id) rather than deleting this check.`
    );
  }
  return found;
}

function factKeyOrThrow(key: string): string {
  if (!PHASE_THREE.factKeys.includes(key)) {
    throw new Error(
      `lib/personas grounds a persona attribute in ProjectFact key "${key}", which is not in PHASE_THREE.factKeys. The extractor will never write it, so the attribute could never be grounded.`
    );
  }
  return key;
}

function metricThresholdOrThrow(id: string): number {
  const criterion = criterionOrThrow(id);
  if (criterion.type !== "metric-threshold") {
    throw new Error(
      `lib/personas expects phase-3 criterion "${id}" to be a metric-threshold, but it is "${criterion.type}".`
    );
  }
  return criterion.threshold;
}

/**
 * The interview floor is READ OFF the phase-3 criterion rather than repeated, so
 * the number the gate blocks on and the number the persona card reports can
 * never drift apart. Today it is 5 — see the STRICTNESS RAMP comment on
 * PHASE_THREE in definitions-discovery.ts for why phase 3 is where the rubric's
 * "always talk to at least 5 people" guideline becomes a hard gate.
 */
export const PERSONA_INTERVIEW_FLOOR = metricThresholdOrThrow(
  "persona-interview-count"
);

/**
 * From the `primary-persona` criterion, verbatim: "a role, a context, and at
 * least two OBSERVABLE attributes you could filter a list on". Prose, so it
 * cannot be derived numerically the way the interview floor can.
 */
export const MIN_OBSERVABLE_ATTRIBUTES = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Evidence.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three things that can stand behind a persona attribute, ranked by what
 * they cost the person who produced them.
 *
 *  - observation — something the founder WATCHED happen, or a number they
 *    measured. The strongest signal the rubric recognises.
 *  - quote — words a real person said, reproduced verbatim.
 *  - assumption — the founder's own stated guess. NOT evidence, and the persona
 *    labels it [Assumption] wherever it appears.
 *
 * WHY `assumption` IS AN EVIDENCE KIND RATHER THAN AN ABSENCE OF EVIDENCE: the
 * `persona-evidence` criterion permits an attribute to be "labelled
 * [Assumption]" instead of sourced. If that escape hatch were modelled as "an
 * attribute with an empty evidence array", a model could fabricate any attribute
 * it liked and slip it past by tagging it. Requiring an `assumption` item to
 * still carry the founder's own words means even a guess has to be traceable to
 * somebody actually guessing it out loud. Fabrication stops being free.
 */
export const EVIDENCE_KINDS = ["observation", "quote", "assumption"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** STORED evidence. Every field load-bearing; nothing optional, nothing blank. */
export const PersonaEvidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  /** The verbatim words, or the verbatim description of what was observed. */
  quote: z.string().min(1),
  /** Who said it / where it was observed. "A user" is not a source; a role is. */
  source: z.string().min(1),
  /**
   * When, AS THE FOUNDER STATED IT ("last Tuesday", "March 2026"). Free text and
   * nullable on purpose: this module has NO CLOCK, so it cannot resolve a
   * relative date, and inventing an absolute one would be manufacturing a fact.
   */
  when: z.string().nullable(),
});

export type PersonaEvidence = z.infer<typeof PersonaEvidenceSchema>;

/**
 * THE CONSTRAINT, EXPRESSED IN THE TYPE SYSTEM.
 *
 * `z.tuple([X], X)` infers `[X, ...X[]]` — a genuinely non-empty array. Not
 * `z.array(X).min(1)`, which infers plain `X[]` and therefore lets
 * `{ status: "evidenced", value: "…", evidence: [] }` typecheck and only fails
 * at runtime, at parse time, in whichever code path remembered to parse.
 *
 * With the tuple, an unevidenced claim is a COMPILE ERROR at every construction
 * site in the codebase, including ones written years from now by someone who
 * never read this comment. That is the difference between "mandatory" and
 * "unrepresentable", and it is the difference the product is built on.
 */
const NonEmptyEvidenceSchema = z.tuple(
  [PersonaEvidenceSchema],
  PersonaEvidenceSchema
);

/** The empty tuple. Only the `not-established` variant may carry it. */
const NoEvidenceSchema = z.tuple([]);

export type NonEmptyEvidence = z.infer<typeof NonEmptyEvidenceSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The attribute vocabulary.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The CLOSED vocabulary of single-valued persona attributes.
 *
 * Closed for the same reason `phase.factKeys` is closed in extract.ts: a model
 * given an open vocabulary invents fields, and an invented field is an
 * unfalsifiable claim wearing a label. Anything outside this list is discarded
 * during normalisation, not stored "just in case".
 *
 * Observable attributes are NOT in this list — they are a repeated structure
 * (`ObservableAttribute[]`) because the `primary-persona` criterion counts them,
 * and counting items in a joined string is exactly the kind of fragile parsing
 * that makes a gate unreliable.
 */
export const PERSONA_ATTRIBUTE_KEYS = [
  "role",
  "context",
  "trigger-event",
  "current-stack",
  "buying-process",
  "budget-owner",
  "reachable-where",
] as const;

export type PersonaAttributeKey = (typeof PERSONA_ATTRIBUTE_KEYS)[number];

export type PersonaAttributeSpec = {
  key: PersonaAttributeKey;
  /** Column heading in the UI. */
  label: string;
  /** The phase-3 exit criterion this attribute feeds, or null if it feeds none. */
  criterionId: string | null;
  /** The ProjectFact key that grounds it. Checked against PHASE_THREE.factKeys. */
  factKey: string;
  /** What the generator is told to produce. Goes verbatim into the prompt. */
  brief: string;
};

/**
 * One spec per key, in render order. `criterionId` and `factKey` are both
 * validated at import time, so a persona attribute can never claim to satisfy a
 * criterion that does not exist or be grounded in a fact nobody extracts.
 */
export const PERSONA_ATTRIBUTE_SPECS: readonly PersonaAttributeSpec[] = [
  {
    key: "role",
    label: "Role",
    criterionId: criterionOrThrow("primary-persona").id,
    factKey: factKeyOrThrow("primary_persona"),
    brief:
      "The job title or role, named the way this person would name it on their own profile. Not a segment ('SMBs'), not a psychographic ('ambitious founders').",
  },
  {
    key: "context",
    label: "Context",
    criterionId: criterionOrThrow("primary-persona").id,
    factKey: factKeyOrThrow("primary_persona"),
    brief:
      "The situation they are in when the problem bites: company type, team, what their day contains. One sentence.",
  },
  {
    key: "trigger-event",
    label: "Trigger event",
    criterionId: criterionOrThrow("trigger-event").id,
    factKey: factKeyOrThrow("persona_trigger_event"),
    brief:
      "The observable event that makes them start looking for a fix, stated as something that happened to a real person on a real day. A state of mind ('they get frustrated') does not qualify.",
  },
  {
    key: "current-stack",
    label: "Current stack",
    criterionId: null,
    factKey: factKeyOrThrow("persona_current_stack"),
    brief:
      "What they use today to cope, named as specific products or a specific manual routine.",
  },
  {
    key: "buying-process",
    label: "Buying process",
    criterionId: criterionOrThrow("buying-process").id,
    factKey: factKeyOrThrow("buying_process"),
    brief:
      "Who chooses, who pays and who can veto, named as roles rather than as people.",
  },
  {
    key: "budget-owner",
    label: "Budget owner",
    criterionId: criterionOrThrow("budget-owner").id,
    factKey: factKeyOrThrow("budget_owner"),
    brief:
      "The role that controls the money, and whether the founder has ever spoken to somebody in that role. No access is a yellow flag to STATE, never to omit.",
  },
  {
    key: "reachable-where",
    label: "Reachable at",
    criterionId: criterionOrThrow("reachable-channel").id,
    factKey: factKeyOrThrow("persona_reachable_where"),
    brief:
      "A named community, list, event, publication or search term where a hundred of these people can actually be reached.",
  },
] as const;

/** Spec lookup. Total over the key union, so no call site needs a null check. */
export const PERSONA_ATTRIBUTE_SPEC_BY_KEY: Record<
  PersonaAttributeKey,
  PersonaAttributeSpec
> = Object.fromEntries(
  PERSONA_ATTRIBUTE_SPECS.map((spec) => [spec.key, spec])
) as Record<PersonaAttributeKey, PersonaAttributeSpec>;

// ─────────────────────────────────────────────────────────────────────────────
// The stored attribute — a three-state union.
// ─────────────────────────────────────────────────────────────────────────────

export const PERSONA_ATTRIBUTE_STATUSES = [
  /** Backed by at least one observation or quote. */
  "evidenced",
  /** Backed only by the founder's own stated guesses. Renders as [Assumption]. */
  "assumed",
  /** No sourced value. Carries a gap and NO value. The fail-closed default. */
  "not-established",
] as const;

export type PersonaAttributeStatus =
  (typeof PERSONA_ATTRIBUTE_STATUSES)[number];

/**
 * Note what the third variant does NOT have: a `value`. It is `z.null()`, not
 * `z.string()` and not an optional string.
 *
 * An empty string would render as a blank line under a confident heading, which
 * reads as "this persona has no buying process" rather than "nobody has
 * established the buying process". Those two sentences point at opposite next
 * actions, so the type refuses to let them share a representation.
 */
export const PersonaAttributeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("evidenced"),
    value: z.string().min(1),
    evidence: NonEmptyEvidenceSchema,
  }),
  z.object({
    status: z.literal("assumed"),
    value: z.string().min(1),
    evidence: NonEmptyEvidenceSchema,
  }),
  z.object({
    status: z.literal("not-established"),
    value: z.null(),
    /** The specific missing thing, as a noun phrase. Never "more detail needed". */
    gap: z.string().min(1),
    evidence: NoEvidenceSchema,
  }),
]);

export type PersonaAttribute = z.infer<typeof PersonaAttributeSchema>;

/**
 * Built from the key list rather than written out, so adding a key to
 * PERSONA_ATTRIBUTE_KEYS makes every persona in the codebase fail to typecheck
 * until it is handled. z.object() requires every key, which is the coverage
 * guarantee decideGate() enforces by hand for exit criteria: a persona in which
 * an attribute is simply ABSENT is not representable, so "absent" and "not
 * established" can never be confused.
 */
const personaAttributesShape = Object.fromEntries(
  PERSONA_ATTRIBUTE_KEYS.map((key) => [key, PersonaAttributeSchema])
) as Record<PersonaAttributeKey, typeof PersonaAttributeSchema>;

export const PersonaAttributesSchema = z.object(personaAttributesShape);
export type PersonaAttributes = z.infer<typeof PersonaAttributesSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The repeated structures.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One filterable trait. `dimension` is the column you would filter on and
 * `value` is what you would filter it to — because the criterion's test is
 * literally "attributes you could filter a list on", and a free-text blob fails
 * that test while looking like it passes.
 */
export const ObservableAttributeSchema = z.object({
  dimension: z.string().min(1),
  value: z.string().min(1),
  evidence: NonEmptyEvidenceSchema,
});

export type ObservableAttribute = z.infer<typeof ObservableAttributeSchema>;

/**
 * A segment deliberately NOT served first. Feeds `single-beachhead` (which needs
 * every other candidate explicitly deprioritised) and `excluded-segments`.
 *
 * EVIDENCE IS REQUIRED HERE TOO. It would have been easy to argue that a
 * deprioritisation is "a decision, not a claim about the world" and let it
 * through unsourced. That argument is how the mandatory-evidence rule acquires
 * its first exception, and a rule with one exception is a rule with as many
 * exceptions as future authors need. An `assumption`-kind item quoting the
 * founder's own reasoning satisfies this, so the cost is one sentence.
 */
export const ExcludedSegmentSchema = z.object({
  segment: z.string().min(1),
  reason: z.string().min(1),
  evidence: NonEmptyEvidenceSchema,
});

export type ExcludedSegment = z.infer<typeof ExcludedSegmentSchema>;

/**
 * The interview count, as the same three-state union. A count with nothing
 * behind it is the easiest number in the world for a model to emit and the
 * hardest for a founder to notice, and it is the number a BLOCKING criterion
 * compares against PERSONA_INTERVIEW_FLOOR — so it gets the same treatment as
 * every other claim.
 */
export const PersonaInterviewsSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("counted"),
    count: z.number().int().min(1),
    /** Derived from PERSONA_INTERVIEW_FLOOR at normalisation time. */
    meetsFloor: z.boolean(),
    evidence: NonEmptyEvidenceSchema,
  }),
  z.object({
    status: z.literal("not-established"),
    count: z.literal(0),
    meetsFloor: z.literal(false),
    gap: z.string().min(1),
    evidence: NoEvidenceSchema,
  }),
]);

export type PersonaInterviews = z.infer<typeof PersonaInterviewsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The persona.
// ─────────────────────────────────────────────────────────────────────────────

export const PersonaSchema = z.object({
  /**
   * A HANDLE, not a claim: "Ops lead at a 20-person agency". It carries no
   * evidence because it asserts nothing on its own — every claim it summarises
   * lives in `attributes`, where it is sourced. It is never rendered as a fact.
   */
  label: z.string().min(1),
  attributes: PersonaAttributesSchema,
  observableAttributes: z.array(ObservableAttributeSchema),
  excludedSegments: z.array(ExcludedSegmentSchema),
  interviews: PersonaInterviewsSchema,
});

export type Persona = z.infer<typeof PersonaSchema>;

/** Bumped whenever the stored JSON shape changes. Read by parsePersonaArtifact. */
export const PERSONA_CONTENT_VERSION = 1;

/**
 * What actually lands in `Document.content`: the persona plus the provenance of
 * the run that produced it.
 *
 * `degradedReasons` is the NO-SILENT-FALLBACK channel. A persona generated from
 * an empty fact store and a persona generated from forty interviews are both
 * valid `Persona` values; without this field the only difference on screen is
 * that one has more "not established" rows, which reads as a thin persona rather
 * than as a refusal. Non-empty means: this version is not a finding.
 */
export const PersonaArtifactSchema = z.object({
  artifact: z.literal("persona"),
  contentVersion: z.literal(PERSONA_CONTENT_VERSION),
  persona: PersonaSchema,
  /** ProjectFact keys that were actually in the prompt. Provenance per version. */
  groundedInFactKeys: z.array(z.string()),
  /**
   * Fact keys named by a BLOCKING phase-3 criterion that did not fit the token
   * budget. Non-empty means the persona was generated blind to something the
   * gate will then demand — the same alarm buildPhaseSystemBlock logs.
   */
  droppedPinnedFactKeys: z.array(z.string()),
  /** Empty ⇒ a real generation. Non-empty ⇒ a fail-closed placeholder. */
  degradedReasons: z.array(z.string()),
});

export type PersonaArtifact = z.infer<typeof PersonaArtifactSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The MODEL-FACING draft. Lenient by design — see the header.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every field `.default()`ed, nothing `.min()`ed, no `.refine()`. A model that
 * returns `evidence: []` MUST parse, so that pure code can turn it into
 * "not established" with a readable gap. If this schema rejected it instead, the
 * whole persona would fall to a parse error and the founder would learn nothing
 * about which attribute the model could not source.
 *
 * `.default()` makes a field OPTIONAL in the emitted JSON Schema, which OpenAI's
 * strict structured-output mode rejects outright. That is fixed where it should
 * be fixed — at the provider call, with `strictJsonSchema: false` — in
 * model-adapter.ts. Do not "fix" it by deleting the defaults here.
 */
export const DraftEvidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS).default("quote"),
  quote: z.string().default(""),
  source: z.string().default(""),
  when: z.string().nullable().default(null),
});

export type DraftEvidence = z.infer<typeof DraftEvidenceSchema>;

export const DraftAttributeSchema = z.object({
  key: z.string().default(""),
  value: z.string().default(""),
  evidence: z.array(DraftEvidenceSchema).default([]),
  /** The model's own admission that it could not source this. Preferred to silence. */
  gap: z.string().nullable().default(null),
});

export type DraftAttribute = z.infer<typeof DraftAttributeSchema>;

export const DraftObservableAttributeSchema = z.object({
  dimension: z.string().default(""),
  value: z.string().default(""),
  evidence: z.array(DraftEvidenceSchema).default([]),
});

export type DraftObservableAttribute = z.infer<
  typeof DraftObservableAttributeSchema
>;

export const DraftExcludedSegmentSchema = z.object({
  segment: z.string().default(""),
  reason: z.string().default(""),
  evidence: z.array(DraftEvidenceSchema).default([]),
});

export type DraftExcludedSegment = z.infer<typeof DraftExcludedSegmentSchema>;

/**
 * `interviewCount` is `z.number()`, NOT `z.number().int().min(0)`. An `.int()`
 * check is a refinement: a model answering 4.5 would fail the whole parse and
 * take the entire persona down with it. Pure code floors and clamps it instead,
 * which is both kinder and more predictable.
 */
export const PersonaDraftSchema = z.object({
  label: z.string().default(""),
  attributes: z.array(DraftAttributeSchema).default([]),
  observableAttributes: z.array(DraftObservableAttributeSchema).default([]),
  excludedSegments: z.array(DraftExcludedSegmentSchema).default([]),
  interviewCount: z.number().default(0),
  interviewEvidence: z.array(DraftEvidenceSchema).default([]),
});

export type PersonaDraft = z.infer<typeof PersonaDraftSchema>;
