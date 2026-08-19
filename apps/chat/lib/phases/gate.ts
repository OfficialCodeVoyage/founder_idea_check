import {
  type CriterionEvaluation,
  type CriterionSeverity,
  type ExitCriterion,
  type GateConfig,
  type GateVerdict,
  JudgeOutputSchema,
  type KnownFact,
  PHASE_COUNT,
  type PhaseDefinition,
  type TranscriptTurn,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// (a) THE PURE PART. No model, no DB, no I/O, no clock. Fully unit-tested.
// ─────────────────────────────────────────────────────────────────────────────

/** Only what decideGate needs to know about a criterion. */
export type GateCriterionMeta = {
  id: string;
  severity: CriterionSeverity;
};

export type DecideGateInput = {
  /** The criteria the phase DEFINES. Empty ⇒ BLOCK (see guard 2). */
  criteria: GateCriterionMeta[];
  gate: GateConfig;
  /** How many facts the project has stored. Below minFactsRequired ⇒ BLOCK. */
  factCount: number;
};

const NO_GAP_NAMED =
  "the judge marked this criterion unsatisfied but named no specific gap";

/**
 * Enforces the invariant the judge schema deliberately does not:
 * a non-`met` status MUST name a gap. A violation is not silently accepted and
 * not silently upgraded — it becomes `not-evaluable`, which fails closed.
 */
export function normalizeEvaluation(
  evaluation: CriterionEvaluation
): CriterionEvaluation {
  const gap = evaluation.gap?.trim() ? evaluation.gap.trim() : null;
  const nextQuestion = evaluation.nextQuestion?.trim()
    ? evaluation.nextQuestion.trim()
    : null;

  if (evaluation.status === "met") {
    return { ...evaluation, gap: null, nextQuestion: null };
  }
  if (gap === null) {
    return {
      ...evaluation,
      status: "not-evaluable",
      gap: NO_GAP_NAMED,
      nextQuestion,
    };
  }
  return { ...evaluation, gap, nextQuestion };
}

function verdict(
  decision: GateVerdict["decision"],
  reason: string,
  perCriterion: CriterionEvaluation[],
  missing: string[],
  nextQuestion: string | null
): GateVerdict {
  return { decision, perCriterion, missing, nextQuestion, reason };
}

function firstQuestion(
  blocking: CriterionEvaluation[],
  fallback: string | null
): string | null {
  for (const e of blocking) {
    if (e.nextQuestion) {
      return e.nextQuestion;
    }
  }
  for (const e of blocking) {
    if (e.gap) {
      return `Answer this before we move on: ${e.gap}`;
    }
  }
  return fallback;
}

/**
 * THE PURE GATE.
 *
 * Rule order is most-severe-first with flat early returns, and every non-PASS
 * return interpolates the specific failing thing into `reason` AT THE POINT OF
 * DECISION, where the numbers are still in scope — never reconstructed later
 * from the verdict. (Discipline borrowed from warden's evaluateExitCriteria.)
 *
 * DIRECTION OF THE EMPTY-SET GUARDS: warden's library WARNs when nothing was
 * evaluated because the dangerous action is guarded downstream. Here phase
 * advance IS the merge — there is no second gate — so every "cannot evaluate"
 * branch fails CLOSED to BLOCK. Never compute a ratio over an empty set, and
 * never let an absent or unrecognized signal default to PASS.
 */
export function decideGate(
  perCriterionRaw: CriterionEvaluation[],
  input: DecideGateInput
): GateVerdict {
  const { criteria, gate, factCount } = input;
  const perCriterion = perCriterionRaw.map(normalizeEvaluation);
  const defined = criteria.length;

  // 1. EMPTY-SET GUARD A — the phase defines nothing to check.
  //    0 of 0 is not 100%. An uncertifiable phase does not advance.
  //    This runs BEFORE the operator opt-out on purpose: a phase with no exit
  //    criteria is a BUG in the phase definition, not a policy choice, and
  //    `enabled: false` must not paper over it.
  if (defined === 0) {
    return verdict(
      "BLOCK",
      "No exit criteria are defined for this phase, so advance cannot be certified.",
      perCriterion,
      ["this phase has no exit criteria to check against"],
      "This phase is misconfigured — it has no exit criteria. Fix the phase definition before continuing."
    );
  }

  // 2. Explicit operator opt-out. The ONLY fail-open path in this function,
  //    and it is reachable only for a phase that actually defines criteria.
  if (gate.enabled === false) {
    return verdict(
      "PASS",
      "Gate disabled by configuration (gate.enabled = false).",
      perCriterion,
      [],
      null
    );
  }

  // 3. EMPTY-SET GUARD B — criteria exist but nothing was evaluated.
  if (perCriterion.length === 0) {
    return verdict(
      "BLOCK",
      `No criteria were evaluated (0 of ${defined}); the judge returned nothing.`,
      perCriterion,
      [`none of the ${defined} exit criteria were evaluated`],
      "I could not assess this phase. Restate where you are and I will re-check."
    );
  }

  // 4. Duplicate ids — an ambiguous verdict is an unknown verdict.
  const seen = new Set<string>();
  for (const e of perCriterion) {
    if (seen.has(e.criterionId)) {
      return verdict(
        "BLOCK",
        `The judge returned duplicate evaluations for criterion "${e.criterionId}".`,
        perCriterion,
        [`duplicate verdict for "${e.criterionId}"`],
        "I could not assess this phase cleanly. Restate where you are and I will re-check."
      );
    }
    seen.add(e.criterionId);
  }

  // 5. Coverage — every defined criterion must have exactly one evaluation.
  //    An unaddressed criterion is unknown, and unknown fails closed.
  const definedIds = new Set(criteria.map((c) => c.id));
  const uncovered = criteria.filter((c) => !seen.has(c.id)).map((c) => c.id);
  const unknown = perCriterion
    .filter((e) => !definedIds.has(e.criterionId))
    .map((e) => e.criterionId);
  if (uncovered.length > 0 || unknown.length > 0) {
    const parts: string[] = [];
    if (uncovered.length > 0) {
      parts.push(`not evaluated: ${uncovered.join(", ")}`);
    }
    if (unknown.length > 0) {
      parts.push(`unrecognized criteria returned: ${unknown.join(", ")}`);
    }
    return verdict(
      "BLOCK",
      `Judge coverage mismatch (${perCriterion.length} evaluations for ${defined} criteria) — ${parts.join("; ")}.`,
      perCriterion,
      parts,
      "I could not assess every exit criterion. Restate where you are and I will re-check."
    );
  }

  // 6. EMPTY-SET GUARD C — nothing has been established about the project.
  //    A confident verdict over an empty fact store is the same 0/0 mistake.
  if (factCount < gate.minFactsRequired) {
    return verdict(
      "BLOCK",
      `Nothing has been established about this project yet (${factCount} stored facts, ${gate.minFactsRequired} required).`,
      perCriterion,
      ["no facts have been established about the project yet"],
      "Start at the beginning: what is the problem, and who has it?"
    );
  }

  const severityOf = new Map(criteria.map((c) => [c.id, c.severity]));
  const isBlocking = (e: CriterionEvaluation) =>
    (severityOf.get(e.criterionId) ?? "blocking") === "blocking";

  // 7. Anything the judge could not assess fails closed — but only where the
  //    criterion is BLOCKING. normalizeEvaluation() escalates any gapless miss
  //    to "not-evaluable", so without this severity check an advisory criterion
  //    (defined as "downgrades to WARN only") would hard-BLOCK instead. Advisory
  //    not-evaluables fall through to the soft-failure branch below.
  const notEvaluable = perCriterion.filter(
    (e) => e.status === "not-evaluable" && isBlocking(e)
  );
  if (notEvaluable.length > 0) {
    const missing = notEvaluable.map((e) => e.gap ?? NO_GAP_NAMED);
    return verdict(
      "BLOCK",
      `${notEvaluable.length} of ${defined} exit criteria could not be assessed: ${missing.join("; ")}.`,
      perCriterion,
      missing,
      firstQuestion(
        notEvaluable,
        "I could not assess part of this phase. Give me more detail and I will re-check."
      )
    );
  }

  // 8. Blocking criteria that are outright unmet.
  const blockingUnmet = perCriterion.filter(
    (e) => e.status === "unmet" && isBlocking(e)
  );
  if (blockingUnmet.length > 0) {
    const missing = blockingUnmet.map((e) => e.gap as string);
    return verdict(
      "BLOCK",
      `${blockingUnmet.length} of ${defined} exit criteria are unmet: ${missing.join("; ")}.`,
      perCriterion,
      missing,
      firstQuestion(blockingUnmet, null)
    );
  }

  const blockingPartial = perCriterion.filter(
    (e) => e.status === "partial" && isBlocking(e)
  );

  // 9. Blocking criteria that are only PARTLY evidenced.
  //
  //    This is the load-bearing branch of the whole product. The judge is an
  //    LLM picking freely between the labels "partial" and "unmet". If
  //    "partial" were a way through, the gate would be exactly one word away
  //    from advisory and the product would quietly become a chat wrapper with
  //    tabs. So a blocking partial BLOCKS by default, and the only way to
  //    soften it is an explicit, per-phase `tolerateBlockingPartials`.
  if (blockingPartial.length > gate.tolerateBlockingPartials) {
    const missing = blockingPartial.map((e) => e.gap as string);
    return verdict(
      "BLOCK",
      `${blockingPartial.length} of ${defined} exit criteria are only partly evidenced: ${missing.join("; ")}.`,
      perCriterion,
      missing,
      firstQuestion(blockingPartial, null)
    );
  }

  // 10. Soft failures — advisory misses, plus any blocking partials that the
  //     phase explicitly tolerates. WARN permits advance but keeps the gap
  //     visible; a tolerated partial must never be reported as PASS.
  const advisorySoft = perCriterion.filter(
    (e) =>
      !isBlocking(e) &&
      (e.status === "unmet" ||
        e.status === "partial" ||
        e.status === "not-evaluable")
  );
  const soft = [...blockingPartial, ...advisorySoft];
  if (soft.length > 0) {
    const missing = soft.map((e) => e.gap as string);
    return verdict(
      "WARN",
      `All blocking exit criteria are met, but ${soft.length} of ${defined} are only partly evidenced: ${missing.join("; ")}.`,
      perCriterion,
      missing,
      firstQuestion(soft, null)
    );
  }

  // 11. Fallthrough: every criterion met, nothing soft outstanding.
  const met = perCriterion.filter((e) => e.status === "met").length;
  return verdict(
    "PASS",
    `All exit criteria met: ${met}/${defined} passed.`,
    perCriterion,
    [],
    null
  );
}

/** Fail-closed verdict for "the judge did not produce a usable answer". */
export function failClosedVerdict(
  reason: string,
  criteria: GateCriterionMeta[]
): GateVerdict {
  return {
    decision: "BLOCK",
    perCriterion: [],
    missing: [reason],
    nextQuestion:
      "I could not assess this phase just now. Restate where you have got to and I will re-check.",
    reason: `Gate failed closed: ${reason} (${criteria.length} criteria were pending).`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure prompt assembly. Exported so a test can assert the judge was given the
// right criteria without ever calling a model.
// ─────────────────────────────────────────────────────────────────────────────

export function describeCriterion(criterion: ExitCriterion): string {
  const head = `- id: ${criterion.id} [${criterion.type}, ${criterion.severity}]`;
  switch (criterion.type) {
    case "artifact-exists":
      return `${head} requires fact "${criterion.factKey}" — ${criterion.description}`;
    case "requirement-satisfied":
      return `${head} requirement "${criterion.requirementId}" — ${criterion.description}`;
    case "metric-threshold":
      return `${head} requires ${criterion.metric} ${criterion.operator} ${criterion.threshold} — ${criterion.description}`;
    case "phase-completed":
      return `${head} requires phase "${criterion.phaseId}" complete — ${criterion.description}`;
    default:
      return `${head} validator "${criterion.customValidator}" — ${criterion.description}`;
  }
}

export function renderFacts(facts: KnownFact[]): string {
  if (facts.length === 0) {
    return "(none established yet)";
  }
  return facts
    .map((f) => `- ${f.key}: ${f.value} (confidence ${f.confidence})`)
    .join("\n");
}

export function renderTranscript(turns: TranscriptTurn[]): string {
  if (turns.length === 0) {
    return "(no conversation yet)";
  }
  return turns.map((t) => `${t.role.toUpperCase()}: ${t.text}`).join("\n\n");
}

export type GateJudgeRequest = {
  system: string;
  prompt: string;
  /** Passed through untouched so an adapter can size the call. */
  criteria: ExitCriterion[];
};

export type BuildGatePromptInput = {
  phase: PhaseDefinition;
  /** Contents of prompts/persona/*.md, comments already stripped. */
  personaPrompt: string;
  /** Contents of prompts/phases/phase-01-problem.md, comments stripped. */
  phasePrompt: string;
  transcript: TranscriptTurn[];
  facts: KnownFact[];
};

export function buildGatePrompt(input: BuildGatePromptInput): GateJudgeRequest {
  const { phase, personaPrompt, phasePrompt, transcript, facts } = input;

  const system = [
    personaPrompt,
    phasePrompt,
    `# Your job right now

You are NOT talking to the founder. You are judging whether phase ${phase.order} of ${PHASE_COUNT} ("${phase.title}") may be exited.

Judge ONLY the evidence in the transcript and the established facts below. Do not
infer, do not be generous, and do not credit enthusiasm as evidence.

For EVERY criterion listed, return exactly one evaluation object with:
- criterionId: the id, copied exactly
- status: "met" | "partial" | "unmet" | "not-evaluable"
- evidence: a direct quote from the transcript, or a fact reference like key=value
- gap: for any status other than "met", the ONE specific thing that is missing,
  written as a concrete noun phrase. Never write "more detail needed".
- nextQuestion: the single question that would close that gap
- confidence: 0-100

Return one evaluation per criterion. No more, no fewer. Do not invent criteria.`,
  ].join("\n\n---\n\n");

  const prompt = [
    "## Exit criteria to judge",
    phase.exitCriteria.map(describeCriterion).join("\n"),
    "",
    "## Established project facts",
    renderFacts(facts),
    "",
    "## Transcript",
    renderTranscript(transcript),
  ].join("\n");

  return { system, prompt, criteria: phase.exitCriteria };
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE IMPURE PART. One async function, one seam.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE SEAM. `GateJudge` is the single injected model-calling function. Tests
 * pass a plain async closure (or the real adapter wrapped around
 * MockLanguageModelV3 from "ai/test"); the route passes
 * createModelGateJudge({ model: await getLanguageModel(...) }).
 *
 * gate.ts NEVER imports "ai", "@/lib/ai/providers" or "@/lib/db/*". That is the
 * property that makes this whole file runnable under vitest with no API key,
 * no network and no database.
 */
export type GateJudge = (request: GateJudgeRequest) => Promise<unknown>;

export type GateDeps = {
  judge: GateJudge;
};

export type EvaluateGateInput = BuildGatePromptInput;

export async function evaluateGate(
  deps: GateDeps,
  input: EvaluateGateInput
): Promise<GateVerdict> {
  const request = buildGatePrompt(input);
  const meta: GateCriterionMeta[] = input.phase.exitCriteria.map((c) => ({
    id: c.id,
    severity: c.severity,
  }));

  let raw: unknown;
  try {
    raw = await deps.judge(request);
  } catch (error) {
    return failClosedVerdict(
      `the judge call failed (${error instanceof Error ? error.message : String(error)})`,
      meta
    );
  }

  const parsed = JudgeOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return failClosedVerdict(
      "the judge returned a response that did not match the expected shape",
      meta
    );
  }

  return decideGate(parsed.data.evaluations, {
    criteria: meta,
    gate: input.phase.gate,
    factCount: input.facts.length,
  });
}
