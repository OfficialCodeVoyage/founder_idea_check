import type { StoredFact } from "@/lib/phases/context";
import { PHASES } from "@/lib/phases/definitions";
import { GateVerdictSchema, PHASE_COUNT } from "@/lib/phases/types";
import { blockquote, singleLine } from "./markdown";
import type {
  ExportGateDecision,
  ExportPhaseState,
  ExportPhaseStatus,
  ExportProject,
  ExportReadiness,
} from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GROUNDING. The layer that makes "never fabricate" mechanical rather than
 * aspirational.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every document generator in lib/export asks THIS module for a value and gets
 * back a `Grounded` — a tagged union that is either an established fact or an
 * explicit absence. There is no third way to get a project-specific string into
 * a generated file, and no generator is allowed to write prose about the
 * project from anything else. That is the whole enforcement mechanism: if a
 * claim is not a `Grounded`, it is not in the document.
 *
 * PURE. Imports lib/phases for the phase VOCABULARY only — definitions.ts and
 * types.ts are themselves pure and import no model, no db and no fs.
 */

/**
 * Below this, a fact is rendered with a visible warning and repeated in the
 * document's "unverified" list.
 *
 * 50 is not arbitrary: it is the default confidence
 * ExtractedFactSchema assigns when the extraction model does not supply one
 * (lib/phases/types.ts), and MIN_FACT_CONFIDENCE in extract.ts is the floor for
 * storing a fact at all. So "below the default" means the model actively chose
 * to express doubt — which is exactly the signal that must survive into the PRD
 * instead of being flattened into confident prose.
 */
export const LOW_CONFIDENCE_CEILING = 50;

/** At or above this a fact is presented without qualification. */
export const HIGH_CONFIDENCE_FLOOR = 80;

export const CONFIDENCE_BANDS = ["low", "medium", "high"] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

/** PURE. Band a 0-100 confidence. Boundaries are inclusive at the floor. */
export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence < LOW_CONFIDENCE_CEILING) {
    return "low";
  }
  if (confidence < HIGH_CONFIDENCE_FLOOR) {
    return "medium";
  }
  return "high";
}

/**
 * A value that is allowed into a generated document.
 *
 * `not-established` carries the key so the generator can name the thing that is
 * missing. It never carries a placeholder value — there is nothing to place.
 */
export type Grounded =
  | {
      status: "established";
      key: string;
      value: string;
      confidence: number;
      band: ConfidenceBand;
      /** Phase that wrote the fact. Provenance the founder can audit. */
      phaseKey: string;
    }
  | { status: "not-established"; key: string };

export type FactIndex = ReadonlyMap<string, StoredFact>;

/**
 * PURE. Index facts by key, keeping the best row per key.
 *
 * ProjectFact carries UNIQUE (projectId, key), so duplicates cannot come from
 * one project — but buildHandoff is a pure function anyone may call with a
 * merged or hand-built list, and a duplicate would make the export
 * order-dependent. Tie-break rule is deliberately IDENTICAL to
 * lib/phases/context.ts `dedupeByKey` (highest confidence, then most recent) so
 * the fact the PRD shows is the same one the gate judged. Two different
 * "winning" facts for one key across the two paths would be the worst possible
 * bug: a document that disagrees with the gate that certified it.
 */
export function buildFactIndex(facts: readonly StoredFact[]): FactIndex {
  const best = new Map<string, StoredFact>();
  for (const fact of facts) {
    const existing = best.get(fact.key);
    if (!existing) {
      best.set(fact.key, fact);
      continue;
    }
    if (fact.confidence > existing.confidence) {
      best.set(fact.key, fact);
      continue;
    }
    if (
      fact.confidence === existing.confidence &&
      fact.updatedAt.getTime() > existing.updatedAt.getTime()
    ) {
      best.set(fact.key, fact);
    }
  }
  return best;
}

/**
 * PURE. The single entry point for "what do we know about X?".
 *
 * A stored row whose value is blank after normalisation is treated as
 * NOT ESTABLISHED, not as an empty fact. A heading followed by an empty
 * blockquote reads as "we looked and there was nothing there", which is a claim
 * the project never made.
 */
export function groundFact(index: FactIndex, key: string): Grounded {
  const fact = index.get(key);
  if (!fact || singleLine(fact.value).length === 0) {
    return { status: "not-established", key };
  }
  return {
    status: "established",
    key,
    value: fact.value,
    confidence: fact.confidence,
    band: confidenceBand(fact.confidence),
    phaseKey: fact.phaseKey,
  };
}

/** The marker prefixed to any low-confidence value, in every document. */
export const LOW_CONFIDENCE_MARKER = "⚠ LOW CONFIDENCE";

/**
 * PURE. Render one grounded value as a Markdown block.
 *
 * SHAPE IS FIXED ACROSS EVERY DOCUMENT on purpose. The founder learns the
 * legend once — bold label, provenance line, blockquote — and can then scan any
 * generated file for the two things that matter: what is missing, and what is
 * shaky. A per-document format would hide both.
 */
export function renderGrounded(grounded: Grounded, label: string): string {
  if (grounded.status === "not-established") {
    return [
      `**${label}** — _not established_.`,
      "",
      `No \`${grounded.key}\` fact was recorded, so this document makes no claim about it. Answer it in the workflow and re-export.`,
    ].join("\n");
  }

  const provenance = `_confidence ${grounded.confidence}/100 · established in phase \`${grounded.phaseKey}\` · fact \`${grounded.key}\`_`;
  const warning =
    grounded.band === "low"
      ? `\n\n> ${LOW_CONFIDENCE_MARKER} — the extractor was unsure of this. Treat it as an open question, not a finding.`
      : "";

  return `**${label}**\n\n${provenance}\n\n${blockquote(grounded.value)}${warning}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The vocabulary: fact key -> human label, and phase -> section.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Human-readable label for every fact key the eight phases can write.
 *
 * EXHAUSTIVENESS IS ASSERTED IN grounding.test.ts against PHASES. That test is
 * the drift guard: the day someone adds a fact key to a phase definition, the
 * test fails rather than the PRD quietly rendering a section titled
 * "gtm channel cac". A generated document with a machine-shaped heading tells
 * the founder the generator does not know what it is talking about, and they
 * will be right.
 */
export const FACT_LABELS: Readonly<Record<string, string>> = {
  // Phase 1 — problem validation
  problem_statement: "Problem statement",
  target_user: "Target user",
  problem_frequency: "How often the problem occurs",
  problem_intensity: "What it costs when it occurs",
  existing_workarounds: "Workarounds people already use",
  willingness_to_pay: "Evidence of willingness to pay",
  evidence_type: "Type of evidence gathered",
  people_interviewed: "People interviewed",
  validation_score: "Problem validation score",

  // Phase 2 — solution shaping
  solution_concept: "Solution concept",
  solution_mechanism: "How the solution works",
  workaround_displaced: "Workaround this displaces",
  solution_advantage: "Advantage over the workaround",
  switching_cost: "Cost of switching",
  riskiest_assumption: "Riskiest assumption",
  assumption_test: "How the riskiest assumption gets tested",
  excluded_scope: "Explicitly out of scope",
  alternatives_considered: "Alternatives considered and rejected",

  // Phase 3 — user personas
  primary_persona: "Primary persona",
  persona_trigger_event: "Trigger event",
  persona_current_stack: "Tools the persona uses today",
  buying_process: "Buying process",
  budget_owner: "Who owns the budget",
  persona_reachable_where: "Where the persona can be reached",
  excluded_segments: "Segments deliberately not served",
  persona_interviews_count: "Persona interviews conducted",

  // Phase 4 — demand verification
  demand_test_design: "Demand test design",
  demand_test_channel: "Channel the demand test ran in",
  demand_signal_type: "Type of demand signal collected",
  demand_pass_threshold: "Pass threshold set before the test",
  demand_test_sample_size: "Demand test sample size",
  demand_commitments_count: "Costly commitments received",
  demand_conversion_rate: "Demand test conversion rate",
  demand_verdict: "Demand test verdict",

  // Phase 5 — positioning
  positioning_statement: "Positioning statement",
  competitive_set: "Competitive set",
  primary_alternative: "Primary alternative being displaced",
  differentiation_claim: "Differentiation claim",
  proof_of_claim: "Proof of the differentiation claim",
  category_frame: "Category frame",
  objection_and_answer: "Main objection and its answer",

  // Phase 6 — MVP scope
  mvp_core_flow: "MVP core flow",
  mvp_included_features: "In scope for the MVP",
  mvp_excluded_features: "Out of scope for the MVP",
  mvp_success_metric: "MVP success metric",
  mvp_success_threshold: "MVP success threshold",
  mvp_build_weeks: "Build window in weeks",
  mvp_named_first_users: "Named first users",
  mvp_manual_parts: "Parts done manually at first",

  // Phase 7 — pricing and unit economics
  pricing_model: "Pricing model",
  pricing_value_metric: "Value metric priced against",
  price_point: "Price point",
  payer_role: "Who pays",
  gross_margin_pct: "Gross margin (%)",
  cac_estimate: "Customer acquisition cost estimate",
  ltv_estimate: "Lifetime value estimate",
  cac_payback_months: "CAC payback period (months)",
  breakeven_customers: "Customers needed to break even",

  // Phase 8 — go-to-market
  primary_channel: "Primary channel",
  channel_rationale: "Why that channel",
  gtm_motion: "Repeatable go-to-market motion",
  first_ten_plan: "Plan for the first ten customers",
  gtm_channel_cac: "Channel CAC",
  gtm_channel_test_count: "Channel tests run",
  launch_target: "Launch target and date",
  gtm_kill_rule: "Kill rule",
};

const UNDERSCORE = /_/g;

/**
 * PURE. Label for a key, falling back to a de-snaked form.
 *
 * The fallback exists for keys stored by an older or newer phase definition
 * than the one this build knows about — never for a key in the CURRENT
 * definitions, which the exhaustiveness test forbids. A fallback that silently
 * covered current keys would make that test pointless.
 */
export function labelFor(key: string): string {
  const label = FACT_LABELS[key];
  if (label) {
    return label;
  }
  const spaced = key.replace(UNDERSCORE, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One PRD / roadmap section, derived from a phase definition. */
export type ExportSection = {
  phaseKey: string;
  order: number;
  title: string;
  goal: string;
  /** In the order the phase definition lists them. */
  factKeys: string[];
};

/**
 * PURE. The document outline, DERIVED from PHASES rather than transcribed.
 *
 * Transcribing it would create a second source of truth that drifts the moment
 * a phase gains a fact key, and the drift would be invisible: the PRD would
 * simply stop mentioning the new thing. Deriving means the outline is wrong
 * only if the phase definitions are wrong.
 */
export function exportSections(): ExportSection[] {
  return PHASES.map((phase) => ({
    phaseKey: phase.key,
    order: phase.order,
    title: phase.title,
    goal: phase.goal,
    factKeys: [...phase.factKeys],
  })).sort((a, b) => a.order - b.order);
}

/** PURE. Every fact key the workflow can produce, in phase order. */
export function allWorkflowFactKeys(): string[] {
  return exportSections().flatMap((section) => section.factKeys);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase state.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PURE. Read the stored GateVerdict json blob into the `missing` gap list.
 *
 * The column is `json` and therefore `unknown` at the type level. Parsing it
 * with the SAME schema the gate wrote it with (GateVerdictSchema) means a blob
 * from an older shape degrades to an empty gap list rather than throwing
 * mid-export — an export that fails because one historical row has an extra
 * field would be a spectacular own goal. Degrade, but never invent: an
 * unparseable verdict yields NO gaps, never a fabricated one.
 */
export function missingFromVerdict(verdict: unknown): string[] {
  const parsed = GateVerdictSchema.safeParse(verdict);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.missing;
}

/**
 * PURE. Phase state for a phase key, defaulting to `locked` with no verdict.
 *
 * FAILS CLOSED: a phase with no row has never been evaluated, so it is
 * reported as locked and un-decided — never as passed, and never as "probably
 * fine". Same rule as decideGate's empty-set guards.
 */
export function phaseStateFor(
  states: readonly ExportPhaseState[],
  phaseKey: string
): ExportPhaseState {
  const found = states.find((state) => state.phaseKey === phaseKey);
  if (found) {
    return found;
  }
  return {
    phaseKey,
    status: "locked",
    decision: null,
    reason: null,
    nextQuestion: null,
    missing: [],
  };
}

/** PURE. The label shown in every roadmap and status table. */
export function phaseStatusLabel(
  status: ExportPhaseStatus,
  decision: ExportGateDecision | null
): string {
  if (status === "passed") {
    return decision === "WARN" ? "passed (with warnings)" : "passed";
  }
  if (status === "active") {
    return decision ? `in progress — last gate ${decision}` : "in progress";
  }
  return "not started";
}

/**
 * PURE. How much of the workflow is actually finished.
 *
 * A phase counts as passed ONLY when its stored status is `passed`. The gate
 * decision alone is not enough: a PASS verdict that was never committed by
 * activateProjectPhase is a verdict, not a transition, and treating it as one
 * would let the export claim a phase was cleared when the runtime never agreed.
 */
export function decideExportReadiness(input: {
  facts: readonly StoredFact[];
  phases: readonly ExportPhaseState[];
}): ExportReadiness {
  const factCount = buildFactIndex(input.facts).size;
  const passedPhaseKeys = PHASES.filter(
    (phase) => phaseStateFor(input.phases, phase.key).status === "passed"
  ).map((phase) => phase.key);

  if (factCount === 0) {
    return {
      level: "empty",
      passedPhaseKeys,
      phaseCount: PHASE_COUNT,
      factCount,
      reason:
        "Nothing has been established about this project yet (0 stored facts), so there is nothing to hand off.",
    };
  }

  if (passedPhaseKeys.length === PHASE_COUNT) {
    return {
      level: "complete",
      passedPhaseKeys,
      phaseCount: PHASE_COUNT,
      factCount,
      reason: `All ${PHASE_COUNT} phases passed their gate, from ${factCount} established facts.`,
    };
  }

  return {
    level: "partial",
    passedPhaseKeys,
    phaseCount: PHASE_COUNT,
    factCount,
    reason: `${passedPhaseKeys.length} of ${PHASE_COUNT} phases passed their gate, from ${factCount} established facts. Everything the remaining phases would have settled is marked as not established.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The derived view every document renderer receives.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the document renderers are allowed to see.
 *
 * They receive THIS, never the raw BuildHandoffInput, so no renderer can reach
 * past the grounding layer to a raw fact row and paste `.value` into prose
 * without going through groundFact(). The type is the enforcement.
 */
export type DocumentContext = {
  project: ExportProject;
  /** Slugified, path-safe. The repo directory name. */
  repoName: string;
  index: FactIndex;
  phases: readonly ExportPhaseState[];
  readiness: ExportReadiness;
  sections: readonly ExportSection[];
  /** `YYYY-MM-DD`, UTC. Pre-formatted so no renderer touches a Date. */
  generatedOn: string;
  /** Workflow fact keys with no established value, in phase order. */
  notEstablishedKeys: readonly string[];
  /** Established keys below LOW_CONFIDENCE_CEILING, in phase order. */
  lowConfidenceKeys: readonly string[];
  /** Stored keys belonging to no phase vocabulary, sorted. */
  unrecognizedKeys: readonly string[];
};

/**
 * PURE. UTC `YYYY-MM-DD`.
 *
 * UTC, not local: the same snapshot exported from a laptop in Auckland and a
 * server in Virginia must produce the same bytes, and `toLocaleDateString`
 * additionally depends on the host's ICU build — the same "works on my machine"
 * nondeterminism lib/phases/context.ts refuses localeCompare for.
 */
export function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** PURE. Derive the full rendering view from a validated snapshot. */
export function buildDocumentContext(input: {
  project: ExportProject;
  repoName: string;
  facts: readonly StoredFact[];
  phases: readonly ExportPhaseState[];
  generatedAt: Date;
}): DocumentContext {
  const index = buildFactIndex(input.facts);
  const sections = exportSections();
  const workflowKeys = allWorkflowFactKeys();
  const workflowKeySet = new Set(workflowKeys);

  const notEstablishedKeys: string[] = [];
  const lowConfidenceKeys: string[] = [];
  for (const key of workflowKeys) {
    const grounded = groundFact(index, key);
    if (grounded.status === "not-established") {
      notEstablishedKeys.push(key);
      continue;
    }
    if (grounded.band === "low") {
      lowConfidenceKeys.push(key);
    }
  }

  // Sorted by code point, not localeCompare — see formatUtcDate.
  const unrecognizedKeys = [...index.keys()]
    .filter((key) => !workflowKeySet.has(key))
    .sort();

  return {
    project: input.project,
    repoName: input.repoName,
    index,
    phases: input.phases,
    readiness: decideExportReadiness({
      facts: input.facts,
      phases: input.phases,
    }),
    sections,
    generatedOn: formatUtcDate(input.generatedAt),
    notEstablishedKeys,
    lowConfidenceKeys,
    unrecognizedKeys,
  };
}
