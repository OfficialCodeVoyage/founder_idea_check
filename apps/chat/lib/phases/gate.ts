import {
  type CriterionClosure,
  type CriterionEvaluation,
  type CriterionSeverity,
  type ExitCriterion,
  type GateConfig,
  type GateObstacle,
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
  /**
   * How this criterion can be closed. REQUIRED, not defaulted here: the
   * definition already defaults it (`CRITERION_CLOSURES`), and a second silent
   * default in the gate would hide a phase that forgot to classify at all.
   */
  closure: CriterionClosure;
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
  nextQuestion: string | null,
  obstacle: GateObstacle | null
): GateVerdict {
  return { decision, perCriterion, missing, nextQuestion, reason, obstacle };
}

function obstacleFor(
  kind: GateObstacle["kind"],
  evaluations: readonly CriterionEvaluation[] = []
): GateObstacle {
  return { kind, criterionIds: evaluations.map((e) => e.criterionId) };
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
 * The question asked when the only thing left needs fieldwork.
 *
 * IT IS BUILT HERE, NOT TAKEN FROM THE JUDGE, and that is the entire point. The
 * judge's own `nextQuestion` on attempt 7 was "what evidence-backed 1-5 scores
 * do frequency, intensity, workarounds, and willingness to pay receive?" — four
 * typed integers away from passing the phase on numbers nobody had measured.
 * A question answerable from an armchair is a BUG in a gate like this one, not a
 * prompt-quality problem, so the armchair-answerable question is discarded
 * rather than improved.
 *
 * What replaces it tracks the INSTRUMENT: the protocol, the recruitment, the
 * sample, and the threshold fixed BEFORE the data arrives. Pre-registering the
 * threshold is what stops the eventual number being read backwards into a pass.
 */
function instrumentQuestion(blocking: CriterionEvaluation[]): string {
  const ids = blocking.map((e) => e.criterionId).join(", ");
  return `What is left open (${ids}) needs field data that does not exist yet, so do not estimate it and do not ask me to: what is the protocol that will produce it — who you will talk to, how you will reach them, how many, and the pass/fail threshold you are fixing in advance of seeing any of it?`;
}

/**
 * The reason line and the arm for a BLOCKING SHORTFALL, in one place.
 *
 * Lives outside `decideGate` so that branch stays a flat early return. The only
 * thing `fieldworkOnly` changes is the WORDING and the ARM — never the decision.
 * A phase whose evidence is merely hard to get has still not got it.
 */
function shortfall(
  what: "unmet" | "partial",
  outstanding: CriterionEvaluation[],
  defined: number,
  fieldworkOnly: boolean
): { lead: string; kind: GateObstacle["kind"] } {
  return {
    lead: `${outstanding.length} of ${defined} exit criteria ${SHORTFALL_PHRASE[fieldworkOnly ? "fieldwork" : "plain"][what]}`,
    kind: fieldworkOnly ? "fieldwork-required" : "evidence-missing",
  };
}

const SHORTFALL_PHRASE = {
  plain: {
    unmet: "are unmet",
    partial: "are only partly evidenced",
  },
  fieldwork: {
    unmet: "need field data that does not exist yet",
    partial:
      "are only partly evidenced and the rest needs field data that does not exist yet",
  },
} as const;

/**
 * THE INVARIANT: the gate may never ask for a value the founder cannot yet
 * have.
 *
 * A criterion the founder could close by answering is always preferred, because
 * it is genuinely closable this turn. Only when EVERY outstanding criterion
 * needs fieldwork does the question change shape — and then it changes to the
 * instrument, never to a softer version of the same unanswerable ask.
 */
function questionFor(
  outstanding: CriterionEvaluation[],
  closureOf: (evaluation: CriterionEvaluation) => CriterionClosure,
  fallback: string | null
): { nextQuestion: string | null; fieldworkOnly: boolean } {
  if (outstanding.length === 0) {
    return { nextQuestion: fallback, fieldworkOnly: false };
  }
  const answerableNow = outstanding.filter(
    (e) => closureOf(e) === "in-conversation"
  );
  if (answerableNow.length > 0) {
    return {
      nextQuestion: firstQuestion(answerableNow, fallback),
      fieldworkOnly: false,
    };
  }
  return {
    nextQuestion: instrumentQuestion(outstanding),
    fieldworkOnly: true,
  };
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
      "This phase is misconfigured — it has no exit criteria. Fix the phase definition before continuing.",
      obstacleFor("phase-misconfigured")
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
      null,
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
      "I could not assess this phase. Restate where you are and I will re-check.",
      obstacleFor("judge-incomplete")
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
        "I could not assess this phase cleanly. Restate where you are and I will re-check.",
        obstacleFor("judge-incomplete")
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
      "I could not assess every exit criterion. Restate where you are and I will re-check.",
      obstacleFor("judge-incomplete")
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
      "Start at the beginning: what is the problem, and who has it?",
      obstacleFor("no-facts-yet")
    );
  }

  const severityOf = new Map(criteria.map((c) => [c.id, c.severity]));
  const isBlocking = (e: CriterionEvaluation) =>
    (severityOf.get(e.criterionId) ?? "blocking") === "blocking";

  // An id with no definition cannot reach here — guard 5 already refused the
  // whole verdict for it — so this fallback is unreachable defence. It leans
  // `in-conversation`, the direction that keeps asking rather than the one that
  // stops asking.
  const closureOf_ = new Map(criteria.map((c) => [c.id, c.closure]));
  const closureOf = (e: CriterionEvaluation): CriterionClosure =>
    closureOf_.get(e.criterionId) ?? "in-conversation";

  // ── THE OPEN SET ─────────────────────────────────────────────────────────
  //
  // Every blocking criterion that is NOT met, most-severe first. All three
  // BLOCK branches below report THIS — not merely the group that happened to
  // decide.
  //
  // THE BUG THIS FIXES. decideGate returns on the first matching rule, and the
  // not-evaluable rule sits above the unmet rule. So a SINGLE criterion
  // flipping between "not-evaluable" and "unmet" moved the headline between
  // "1 of 8" and "5 of 8" while five other criteria sat unmet and unmentioned
  // underneath it. Live, project 01a0279c, the founder saw 5→1→1→1→5→5→1 and
  // read it as four criteria closing and re-opening twice. Nothing of the kind
  // happened: that series is `validation-score` alone changing label. The true
  // count of not-met criteria was 8→8→8→7→7→6→7 — slow monotone progress with
  // ONE genuine regression. The gate was hiding its own findings and then
  // reporting the concealment as movement.
  const notEvaluable = perCriterion.filter(
    (e) => e.status === "not-evaluable" && isBlocking(e)
  );
  const blockingUnmet = perCriterion.filter(
    (e) => e.status === "unmet" && isBlocking(e)
  );
  const blockingPartial = perCriterion.filter(
    (e) => e.status === "partial" && isBlocking(e)
  );
  //
  // ORDERED BY THE PHASE DEFINITION, not by severity. Severity order would put
  // a criterion first or fifth depending on which label the judge reached for,
  // and `missing[0]` is the single line the rail has room to show — so the rail
  // would still lurch on a label flip even with the full set reported. The
  // definition order is stable, and it is the order the founder already sees
  // the criteria listed in.
  const definitionOrder = new Map(criteria.map((c, index) => [c.id, index]));
  const openBlocking = [
    ...notEvaluable,
    ...blockingUnmet,
    ...blockingPartial,
  ].sort(
    (a, b) =>
      (definitionOrder.get(a.criterionId) ?? 0) -
      (definitionOrder.get(b.criterionId) ?? 0)
  );
  const openGaps = openBlocking.map((e) => e.gap ?? NO_GAP_NAMED);

  /**
   * The reason line: what decided, plus how much else is still open.
   *
   * The trailing count is the half that was missing. "1 of 8 could not be
   * assessed" was true and, standing alone, deeply misleading.
   */
  function openReason(lead: string, decidedBy: CriterionEvaluation[]): string {
    const rest = openBlocking.length - decidedBy.length;
    const tail =
      rest > 0
        ? `, and ${rest} more of the ${defined} ${rest === 1 ? "is" : "are"} still open`
        : "";
    return `${lead}${tail}: ${openGaps.join("; ")}.`;
  }

  // 7. Anything the judge could not assess fails closed — but only where the
  //    criterion is BLOCKING. normalizeEvaluation() escalates any gapless miss
  //    to "not-evaluable", so without this severity check an advisory criterion
  //    (defined as "downgrades to WARN only") would hard-BLOCK instead. Advisory
  //    not-evaluables fall through to the soft-failure branch below.
  //
  //    The QUESTION is chosen over the whole open set, not over this group: if
  //    anything still open is answerable in conversation, that is what to ask,
  //    whichever group decided the verdict.
  if (notEvaluable.length > 0) {
    const { nextQuestion } = questionFor(
      openBlocking,
      closureOf,
      "I could not assess part of this phase. Give me more detail and I will re-check."
    );
    return verdict(
      "BLOCK",
      openReason(
        `${notEvaluable.length} of ${defined} exit criteria could not be assessed`,
        notEvaluable
      ),
      perCriterion,
      openGaps,
      nextQuestion,
      obstacleFor("not-evaluable", openBlocking)
    );
  }

  // 8. Blocking criteria that are outright unmet.
  if (blockingUnmet.length > 0) {
    const { nextQuestion, fieldworkOnly } = questionFor(
      openBlocking,
      closureOf,
      null
    );
    // STILL BLOCK. `fieldworkOnly` changes the QUESTION and the arm, never the
    // decision — the refusal is the product, and a phase that advanced because
    // its evidence was merely hard to get would advance on nothing.
    const parts = shortfall("unmet", blockingUnmet, defined, fieldworkOnly);
    return verdict(
      "BLOCK",
      openReason(parts.lead, blockingUnmet),
      perCriterion,
      openGaps,
      nextQuestion,
      obstacleFor(parts.kind, openBlocking)
    );
  }

  // 9. Blocking criteria that are only PARTLY evidenced.
  //
  //    This is the load-bearing branch of the whole product. The judge is an
  //    LLM picking freely between the labels "partial" and "unmet". If
  //    "partial" were a way through, the gate would be exactly one word away
  //    from advisory and the product would quietly become a chat wrapper with
  //    tabs. So a blocking partial BLOCKS by default, and the only way to
  //    soften it is an explicit, per-phase `tolerateBlockingPartials`.
  if (blockingPartial.length > gate.tolerateBlockingPartials) {
    const { nextQuestion, fieldworkOnly } = questionFor(
      openBlocking,
      closureOf,
      null
    );
    const parts = shortfall("partial", blockingPartial, defined, fieldworkOnly);
    return verdict(
      "BLOCK",
      openReason(parts.lead, blockingPartial),
      perCriterion,
      openGaps,
      nextQuestion,
      obstacleFor(parts.kind, openBlocking)
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
    const { nextQuestion } = questionFor(soft, closureOf, null);
    return verdict(
      "WARN",
      `All blocking exit criteria are met, but ${soft.length} of ${defined} are only partly evidenced: ${missing.join("; ")}.`,
      perCriterion,
      missing,
      nextQuestion,
      obstacleFor("advisory-only", soft)
    );
  }

  // 11. Fallthrough: every criterion met, nothing soft outstanding.
  const met = perCriterion.filter((e) => e.status === "met").length;
  return verdict(
    "PASS",
    `All exit criteria met: ${met}/${defined} passed.`,
    perCriterion,
    [],
    null,
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
    obstacle: { kind: "judge-incomplete", criterionIds: [] },
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

/**
 * The fact ledger as the judge and the extractor both see it.
 *
 * THE FOUNDER MARKER IS THE POINT OF THE PROVENANCE COLUMN. A fact the founder
 * corrected by hand is not evidence drawn from the transcript, and a judge that
 * cannot tell the two apart can be passed on an assumption the founder typed
 * themselves. The marker is what makes that weighable — it is why the column
 * exists at all, rather than being a badge in the UI.
 *
 * Extracted facts render exactly as before, byte for byte, so no existing
 * prompt or fixture changes.
 */
export function renderFacts(facts: KnownFact[]): string {
  if (facts.length === 0) {
    return "(none established yet)";
  }
  return facts
    .map((f) => {
      const asserted =
        f.origin === "founder"
          ? ", asserted by the founder, not extracted"
          : "";
      return `- ${f.key}: ${f.value} (confidence ${f.confidence}${asserted})`;
    })
    .join("\n");
}

/**
 * What renderTranscript puts BETWEEN two turns. Exported so context.ts can
 * price a join without hard-coding a copy of it — budgetTranscript's additive
 * prescan needs the separator's own token cost, and a silent drift between the
 * two would make the prescan estimate wrong in a way nothing would catch.
 */
export const TRANSCRIPT_SEPARATOR = "\n\n";

export function renderTranscript(turns: TranscriptTurn[]): string {
  if (turns.length === 0) {
    return "(no conversation yet)";
  }
  return turns
    .map((t) => `${t.role.toUpperCase()}: ${t.text}`)
    .join(TRANSCRIPT_SEPARATOR);
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
    closure: c.closure,
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
