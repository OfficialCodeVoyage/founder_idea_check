import {
  approxTokenCount,
  budgetTranscript,
  pinnedFactKeys,
  type StoredFact,
  selectAndRenderFacts,
  type TokenCounter,
} from "@/lib/phases/context";
import { PHASE_THREE } from "@/lib/phases/definitions-discovery";
import { describeCriterion, renderTranscript } from "@/lib/phases/gate";
import type { TranscriptTurn } from "@/lib/phases/types";
import { EMPTY_FACT_STORE, personaAttributeEntries } from "./normalize";
import {
  EVIDENCE_KINDS,
  MIN_OBSERVABLE_ATTRIBUTES,
  PERSONA_ATTRIBUTE_SPECS,
  PERSONA_INTERVIEW_FLOOR,
  type Persona,
  type PersonaEvidence,
} from "./types";

/**
 * PURE PROMPT ASSEMBLY. No model, no DB, no clock. Exported so a test can assert
 * the generator was handed the right facts and the right refusal WITHOUT ever
 * calling a model — the same reason buildGatePrompt is exported from gate.ts.
 *
 * GROUNDING IS THE POINT OF THIS FILE. A persona generator with no facts in its
 * prompt is a plausible-fiction generator, and it will produce its most
 * convincing output at exactly the moment the founder knows least. So the facts
 * are selected and budgeted through the SAME seam the chat path uses
 * (lib/phases/context.ts) rather than a second one invented here: one ranker,
 * one budget, one definition of "relevant", and a persona that can never be
 * grounded in a different view of the project than the gate is judging.
 */

/**
 * How many tokens of established fact the persona call may read.
 *
 * Roughly twice PHASE_FACT_BUDGET_TOKENS (900), which is the PER-TURN budget in
 * runtime.ts. Persona generation is a one-off the founder explicitly asks for,
 * not a cost paid on every message, so it can afford to see more of the store —
 * and grounding is the entire justification for the call existing.
 */
export const PERSONA_FACT_BUDGET_TOKENS = 1800;

/**
 * How many tokens of transcript the persona call may read.
 *
 * Half the gate's 24k. The gate has to justify a verdict about the whole phase;
 * the persona only needs the conversation in which the founder described these
 * people, and the fact store carries everything older — which is the bargain
 * fact injection exists to make.
 */
export const PERSONA_TRANSCRIPT_BUDGET_TOKENS = 12_000;

export type PersonaPromptRequest = {
  system: string;
  prompt: string;
};

export type BuildPersonaPromptInput = {
  /** Contents of prompts/persona/*.md, comments already stripped. */
  personaPrompt: string;
  /** Contents of prompts/phases/phase-03-personas.md, comments stripped. */
  phasePrompt: string;
  /** Rows from ProjectFact, widened. THE grounding. */
  facts: StoredFact[];
  transcript?: TranscriptTurn[];
  /** Ranks the fact block against what this request is actually about. */
  latestUserMessage?: string;
  /** The version being regenerated, if any. Makes this a revision, not a reroll. */
  previous?: Persona | null;
  factBudgetTokens?: number;
  transcriptBudgetTokens?: number;
  /** Defaults to the dependency-free approximation. runtime injects tiktoken. */
  countTokens?: TokenCounter;
};

export type PersonaPromptBuild = {
  request: PersonaPromptRequest;
  /** Fact keys that actually reached the model. Provenance for this version. */
  groundedInFactKeys: string[];
  /** Pinned keys that were in the store but did not fit the budget. */
  droppedPinnedFactKeys: string[];
  /** Pinned keys that are not in the store at all. */
  missingPinnedFactKeys: string[];
  /**
   * NON-EMPTY ⇒ DO NOT CALL THE MODEL. generatePersona returns the fail-closed
   * persona instead. A refusal is a real answer here, not an error path.
   */
  refusals: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Renderers. Pure, and reused by the export path.
// ─────────────────────────────────────────────────────────────────────────────

/** PURE. One attribute's brief, as the generator reads it. */
function renderAttributeBrief(): string {
  return PERSONA_ATTRIBUTE_SPECS.map(
    (spec) => `- ${spec.key} — ${spec.brief}`
  ).join("\n");
}

/**
 * PURE. Renders a persona as markdown.
 *
 * Every value is printed WITH its status and its sources. There is deliberately
 * no "clean" rendering mode that drops the provenance: a persona stripped of its
 * evidence is indistinguishable from one that never had any, and the moment such
 * a renderer exists it is the one that ends up in the pitch deck.
 */
function renderEvidenceLines(evidence: readonly PersonaEvidence[]): string[] {
  return evidence.map((e) => {
    const when = e.when ? `, ${e.when}` : "";
    return `  - (${e.kind}) "${e.quote}" — ${e.source}${when}`;
  });
}

function renderAttributeLines(persona: Persona): string[] {
  const lines: string[] = [];
  for (const { spec, attribute } of personaAttributeEntries(persona)) {
    if (attribute.status === "not-established") {
      lines.push(`## ${spec.label}`, `NOT ESTABLISHED — ${attribute.gap}`, "");
      continue;
    }
    const tag = attribute.status === "assumed" ? " [Assumption]" : "";
    lines.push(
      `## ${spec.label}${tag}`,
      attribute.value,
      ...renderEvidenceLines(attribute.evidence),
      ""
    );
  }
  return lines;
}

function renderObservableLines(persona: Persona): string[] {
  if (persona.observableAttributes.length === 0) {
    return [
      "## Observable attributes (filterable)",
      "NOT ESTABLISHED — no filterable attribute has been evidenced.",
      "",
    ];
  }
  return [
    "## Observable attributes (filterable)",
    ...persona.observableAttributes.map(
      (o) => `- ${o.dimension}: ${o.value} (${o.evidence.length} sources)`
    ),
    "",
  ];
}

function renderExcludedLines(persona: Persona): string[] {
  if (persona.excludedSegments.length === 0) {
    return [
      "## Segments deliberately not served first",
      "NOT ESTABLISHED — no segment has been deprioritised.",
      "",
    ];
  }
  return [
    "## Segments deliberately not served first",
    ...persona.excludedSegments.map((s) => `- ${s.segment} — ${s.reason}`),
    "",
  ];
}

function renderInterviewLines(persona: Persona): string[] {
  const { interviews } = persona;
  if (interviews.status !== "counted") {
    return ["## Interviews", `NOT ESTABLISHED — ${interviews.gap}`];
  }
  const met = interviews.meetsFloor ? "met" : "NOT met";
  return [
    "## Interviews",
    `${interviews.count} evidenced (floor is ${PERSONA_INTERVIEW_FLOOR}; ${met})`,
  ];
}

export function renderPersonaMarkdown(persona: Persona): string {
  return [
    `# ${persona.label}`,
    "",
    ...renderAttributeLines(persona),
    ...renderObservableLines(persona),
    ...renderExcludedLines(persona),
    ...renderInterviewLines(persona),
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// The prompt.
// ─────────────────────────────────────────────────────────────────────────────

function buildSystem(input: BuildPersonaPromptInput): string {
  const job = `# Your job right now

You are NOT talking to the founder. You are writing ONE primary persona for phase
${PHASE_THREE.order} ("${PHASE_THREE.title}") as a structured artifact.

Use ONLY the established facts and the transcript below. Do not infer, do not
generalise from what is typical of this market, and do not fill a gap because the
shape of a persona has a slot for it.

## The attributes you may emit

Emit exactly one object per key, and no key outside this list:

${renderAttributeBrief()}

## Evidence is not optional

Every attribute, every observable attribute and every excluded segment MUST carry
at least one evidence item. An evidence item is:

- kind "${EVIDENCE_KINDS[0]}" — something the founder watched happen or measured.
- kind "${EVIDENCE_KINDS[1]}" — words a real person said, reproduced verbatim.
- kind "${EVIDENCE_KINDS[2]}" — the founder's own stated guess. Quote them saying it.

Each item needs the verbatim words (\`quote\`) and who said or did it (\`source\`).
"A user" is not a source; a role is.

## What to do when you cannot source something

Emit the attribute with an EMPTY evidence array and write the single specific
missing thing in \`gap\`, as a concrete noun phrase. Never "more detail needed".

That is the CORRECT answer and it is not a failure. An attribute you cannot
source is recorded as "not established", which tells the founder exactly what to
go and find out. An attribute you invent is worse than useless: it is the thing
they will build a company on.

Do not repeat one quote across several evidence items to make a thin attribute
look well sourced.

## The rest of the artifact

- observableAttributes: at least ${MIN_OBSERVABLE_ATTRIBUTES} traits you could
  FILTER A LIST ON, each as a (dimension, value) pair — "team size" / "5-20
  people", not "cares about quality".
- excludedSegments: nearby segments deliberately NOT served first, each with the
  reason. Exactly one persona goes first; name what was cut.
- interviewCount: how many people matching this persona have been spoken to
  DIRECTLY, with one evidence item per interview you are counting. The phase
  floor is ${PERSONA_INTERVIEW_FLOOR}. Do not round up to it.`;

  return [input.personaPrompt, input.phasePrompt, job]
    .filter((section) => section.trim().length > 0)
    .join("\n\n---\n\n");
}

function renderPrevious(previous: Persona | null | undefined): string[] {
  if (!previous) {
    return [];
  }
  return [
    "## The persona you are revising",
    "",
    "This is the previous version. Keep every attribute that is still supported,",
    "revise the ones the facts below now contradict, and do NOT re-assert an",
    "attribute whose evidence has gone away.",
    "",
    renderPersonaMarkdown(previous),
    "",
  ];
}

/**
 * PURE. Builds the request, or the refusal.
 *
 * THE REFUSAL IS THE LOAD-BEARING PART. `minFactsRequired` is read off
 * PHASE_THREE's own gate config rather than hardcoded, so the number of facts
 * below which the gate BLOCKS and the number below which the persona generator
 * refuses are the same number by construction. A persona built on zero facts is
 * the single most dangerous artifact this product can emit, because it looks
 * exactly like one built on fifty.
 */
export function buildPersonaPrompt(
  input: BuildPersonaPromptInput
): PersonaPromptBuild {
  const countTokens = input.countTokens ?? approxTokenCount;
  const factBlock = selectAndRenderFacts(
    input.facts,
    { phase: PHASE_THREE, latestUserMessage: input.latestUserMessage },
    input.factBudgetTokens ?? PERSONA_FACT_BUDGET_TOKENS,
    { countTokens }
  );

  const transcript = budgetTranscript(
    input.transcript ?? [],
    input.transcriptBudgetTokens ?? PERSONA_TRANSCRIPT_BUDGET_TOKENS,
    countTokens
  );

  const storedKeys = new Set(input.facts.map((f) => f.key));
  const missingPinnedFactKeys = [...pinnedFactKeys(PHASE_THREE)]
    .filter((key) => !storedKeys.has(key))
    .sort();

  const refusals: string[] = [];
  if (factBlock.includedKeys.length < PHASE_THREE.gate.minFactsRequired) {
    refusals.push(EMPTY_FACT_STORE);
  }

  const prompt = [
    ...renderPrevious(input.previous),
    "## Exit criteria this persona has to satisfy",
    PHASE_THREE.exitCriteria.map(describeCriterion).join("\n"),
    "",
    factBlock.text.length > 0
      ? factBlock.text
      : "## Established project facts\n(none established yet)",
    "",
    transcript.omittedTurns > 0
      ? `## Transcript (the oldest ${transcript.omittedTurns} turns were dropped for budget; the facts above carry them)`
      : "## Transcript",
    renderTranscript(transcript.turns),
  ].join("\n");

  return {
    request: { system: buildSystem(input), prompt },
    groundedInFactKeys: factBlock.includedKeys,
    droppedPinnedFactKeys: factBlock.droppedPinnedKeys,
    missingPinnedFactKeys,
    refusals,
  };
}
