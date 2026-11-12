import {
  type CriterionStatus,
  type GateDecisionValue,
  type GateObstacle,
  GateVerdictSchema,
  PHASE_COUNT,
  type PhaseDefinition,
} from "./types";

/**
 * THE CLOSED LOOP — pure.
 *
 * The gate runs AFTER a turn, in `after()`, once the response has already been
 * flushed. There is therefore no in-band channel back into the turn that was
 * judged: the verdict's only landing site is the SYSTEM PROMPT of the NEXT
 * turn. That is what this file renders.
 *
 * It matters more than it looks. The chat path shows the model at most the last
 * five messages (route.ts / core-chat-agent.ts), while the gate judges the whole
 * project transcript — so a gap found eight turns ago is invisible to the model
 * unless the system prompt carries it. This block is the carrier.
 *
 * DISCIPLINE: imports ./types only. No zod beyond what types re-exports, no DB,
 * no model, no clock, no I/O. Every function here runs under vitest with no API
 * key — which is the point, because the refusal sentence is the single most
 * important string in the product and must not ship untested.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The persisted row, projected.
// ─────────────────────────────────────────────────────────────────────────────

/** The shape of a ProjectPhase row, as far as the prompt is concerned. */
export type PhaseRowLike = {
  status: string;
  decision: string | null;
  reason: string | null;
  nextQuestion: string | null;
  /** `json("verdict")`, i.e. genuinely `unknown`. Parsed, never cast. */
  verdict: unknown;
  attemptCount: number;
};

export type PhaseGateState = {
  /** NULL means the gate has never run for this phase — turn 1. */
  decision: GateDecisionValue | null;
  reason: string | null;
  nextQuestion: string | null;
  /** Ordered gap sentences, sanitised. Empty when the verdict is unusable. */
  missing: string[];
  attemptCount: number;
  /**
   * HOW MANY CRITERIA THE JUDGE ACTUALLY SCORED — `perCriterion.length`.
   *
   * Zero is the signature of `failClosedVerdict` (lib/phases/gate.ts:298),
   * which returns `perCriterion: []` and `missing: [reason]`. Without this
   * number, that shape is indistinguishable from a real refusal naming one
   * gap — so a UI listing `missing` would tell a founder that ONE thing is
   * missing when in fact the gate never ran and all the criteria are still
   * pending. `missing` is a branch-specific sentence list, not the criterion
   * list, and this is what says so.
   */
  criteriaAssessed: number;
  /**
   * WHAT THE JUDGE SAID ABOUT EACH CRITERION — id and status, nothing else.
   *
   * Until this existed the projection counted `perCriterion.length` and then
   * discarded the evaluations, so the only surface a founder reads mid-
   * conversation could say how MANY criteria were judged and never WHICH. The
   * full list of eight, with met / partial / unmet / could-not-be-assessed
   * against each, lived a navigation away on the Phases screen.
   *
   * ID AND STATUS ONLY. `evidence`, `gap` and `nextQuestion` are model-written
   * prose, and this projection feeds both the system prompt and the client. The
   * gap sentences already travel, sanitised and capped, through `missing`;
   * carrying them a second time here would be a second, unsanitised route.
   *
   * EMPTY HAS TWO CAUSES AND THEY ARE NOT THE SAME. `failClosedVerdict` writes
   * `perCriterion: []` — nothing was judged — and an unparseable blob yields
   * the same empty array. `criteriaAssessed` and `verdictReadable` are what
   * tell them apart. A caller must never read a length of zero as "eight
   * criteria came back untouched".
   */
  perCriterion: readonly { criterionId: string; status: CriterionStatus }[];
  /**
   * Did the stored verdict blob still parse?
   *
   * False collapses into `missing: []` above, which on a BLOCK reads as
   * "refused and named no gap" — a different fact from "we can no longer read
   * what it said". Callers must keep the two apart.
   */
  verdictReadable: boolean;
  /**
   * WHICH RULE FIRED, as data rather than as a headline over a list of strings.
   *
   * NULL means the stored verdict predates the field, or the gate PASSed.
   * Callers must not read a null as "an ordinary missing gap": the whole reason
   * this exists is that `fieldwork-required` and `evidence-missing` demand
   * opposite instructions, and folding them together is what produced a gate
   * asking a founder to invent four rubric scores.
   */
  obstacle: GateObstacle | null;
};

/** Longest gap sentence that reaches the model. */
const MAX_GAP_LENGTH = 300;
/**
 * Most gaps that reach the MODEL. `missing[0]` is the one that matters there.
 *
 * THE CAP BELONGS TO THE PROMPT, NOT TO THE PROJECTION, and it moved here from
 * `toPhaseGateState` once the gate started reporting the whole open blocking
 * set on every BLOCK rather than only the group that decided the verdict. Two
 * phases define nine criteria and one defines ten, so a first-turn refusal can
 * legitimately name more than six — and the verdict card renders this same list
 * as the complete answer to "what is in my way", under a heading that counts
 * it. Capping in the projection would have made that heading quietly wrong and
 * hidden real gaps from the one surface that exists to show them.
 */
const MAX_GAPS = 6;
const DECISIONS: readonly string[] = ["PASS", "WARN", "BLOCK"];

function sanitizeGap(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_GAP_LENGTH);
}

function sanitizeSentence(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const clean = sanitizeGap(text);
  return clean.length > 0 ? clean : null;
}

/**
 * PURE. Projects a ProjectPhase row into what the prompt renderer needs.
 *
 * `verdict` is a `json` column, so it is `unknown` and may hold a legacy or
 * hand-edited blob. It is PARSED with GateVerdictSchema, not cast: `missing[]`
 * goes straight into the model's instructions, and a cast would let arbitrary
 * text be injected there. A verdict that does not parse contributes no gaps —
 * the decision, reason and nextQuestion columns still carry the refusal.
 *
 * Returns null for a missing row and for a row the gate has never written, so
 * the caller can tell "not assessed yet" from "assessed and blocked". Neither
 * this nor the rail may collapse the two: the rail resolves a null decision to
 * its own `unassessed` state in `describeRail` (lib/phases/rail.ts), whose
 * branch order deliberately mirrors buildPhaseDirective's, and the SYSTEM
 * PROMPT must not refuse the first message of a project with no gap to name.
 */
export function toPhaseGateState(
  row: PhaseRowLike | null | undefined
): PhaseGateState | null {
  if (!row || row.decision === null || !DECISIONS.includes(row.decision)) {
    return null;
  }
  const parsed = GateVerdictSchema.safeParse(row.verdict);
  const missing = parsed.success
    ? parsed.data.missing.map(sanitizeGap).filter((g) => g.length > 0)
    : [];
  return {
    decision: row.decision as GateDecisionValue,
    reason: sanitizeSentence(row.reason),
    nextQuestion: sanitizeSentence(row.nextQuestion),
    missing,
    attemptCount: row.attemptCount,
    criteriaAssessed: parsed.success ? parsed.data.perCriterion.length : 0,
    perCriterion: parsed.success
      ? parsed.data.perCriterion.map((e) => ({
          criterionId: e.criterionId,
          status: e.status,
        }))
      : [],
    verdictReadable: parsed.success,
    obstacle: parsed.success ? parsed.data.obstacle : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The directive.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After this many gate runs on the same phase, re-asking the same question is
 * the deadlock the founder cannot escape. The directive changes shape instead:
 * name the criterion, and offer a way to get the evidence or reframe.
 *
 * This is the first thing in the codebase to READ ProjectPhase.attemptCount,
 * which phase-queries.ts has been incrementing since the column existed.
 */
export const REPEAT_ATTEMPT_THRESHOLD = 3;

export const DIRECTIVE_HEADING = "## Gate status";

/**
 * WHEN THIS VERDICT WAS TAKEN, stated in the prompt itself.
 *
 * The gate runs in `after()`, once the previous reply has flushed, so the
 * verdict in this block describes the conversation as it stood BEFORE the
 * message the model is now answering. That lag is structural and not a bug —
 * the judge cannot judge a reply that has not been written.
 *
 * The BUG was presenting that snapshot as the present tense and ordering the
 * model to act on it unconditionally. The founder who supplied the missing
 * evidence was told "Phase 4 is not closed yet. The specific gap is still the
 * same" on the very turn the gate wrote PASS, and on another turn the entire
 * reply was the previous verdict's `nextQuestion` re-asked at a founder who had
 * just answered it. The model was not confused; it obeyed.
 *
 * So the vintage is named, and every instruction below that acts on the verdict
 * is conditioned on the founder's latest message first.
 */
const VERDICT_VINTAGE =
  "VINTAGE: this verdict predates the message you are answering and has not seen it. Read that message first. If it supplies what the gap asks for, build on it — do not restate the gap as open, and do not re-ask what it answered.";

/**
 * The phase brief mandates one question at a time, and the base system prompt
 * (lib/ai/prompts.ts) comes first in the same prompt. That base prompt used to
 * demand answers that were "informative, long and very detailed" with
 * "markdown format and tables too"; without this line a refusal arrived as a
 * 600-word markdown table about why the assistant was refusing. Those two lines
 * are gone from the base prompt, but this override stays: the base prompt is
 * shared with every non-phase chat and can grow again, and this is the line
 * that holds the interviewer's voice whatever is said above it.
 *
 * TOOL CALLS ARE COVERED EXPLICITLY. The override used to speak only about the
 * reply, so the long-form mandate was obeyed through createTextDocument
 * instead: a 296-character reply next to a 26KB unrequested document, one
 * instruction obeyed twice. A document is still allowed when the founder asks
 * for one — the fieldwork instrument is a legitimate thing to write down — but
 * not as a way round the brevity rule.
 */
const STYLE_OVERRIDE =
  "Formatting override, and it outranks anything said earlier in this prompt: no tables, no headings, no bulleted essays, no long answers, in replies and tool calls alike. A few sentences and then one question. Never ask two questions in one turn. Write a document only when the founder asks for one, never to deliver the long answer this rule forbids.";

export type PhaseDirectiveInput = {
  /** The phase the founder is in right now. */
  phase: PhaseDefinition;
  /** The gate row for `phase`, or null when the gate has not run for it. */
  state: PhaseGateState | null;
  /** The phase immediately before `phase`, when it is recorded as passed. */
  previousPhase: PhaseDefinition | null;
  nextPhase: PhaseDefinition | null;
  /** Every phase is passed. `phase` is then the last one. */
  workflowComplete: boolean;
};

function phaseLabel(phase: PhaseDefinition): string {
  return `phase ${phase.order} of ${PHASE_COUNT} (${phase.title})`;
}

function gapLines(missing: string[]): string[] {
  if (missing.length === 0) {
    return [];
  }
  // Capped HERE rather than in the projection: this is the prompt's budget, and
  // the card downstream needs the whole list. Ordered by the phase definition
  // upstream, so a cut tail is the end of the phase's criteria rather than an
  // arbitrary slice.
  const shown = missing.slice(0, MAX_GAPS);
  const rest = missing.length - shown.length;
  const lines = ["What is still missing:", ...shown.map((g) => `- ${g}`)];
  if (rest > 0) {
    // Never silently. A prompt that lists six of nine gaps and says so cannot
    // tell the founder the phase is nearly closed.
    lines.push(
      `- ...and ${rest} more open ${rest === 1 ? "criterion" : "criteria"} not listed here.`
    );
  }
  return lines;
}

function askLine(nextQuestion: string | null): string {
  if (!nextQuestion) {
    return "Ask the single most useful question for closing the gap above, then stop and wait.";
  }
  // "Ask exactly this" WITHOUT the escape hatch is what produced a reply that
  // was nothing but the previous turn's question re-asked at a founder who had
  // just answered it. The question still may not be weakened or swapped for an
  // easier one — that is the gate's leverage — but it must not be asked twice.
  return `Unless the founder's latest message already answers it, ask exactly this, rephrased into your own voice if it reads awkwardly but not weakened and not swapped for an easier one:\n"${nextQuestion}"\nThen stop and wait for the answer. If their latest message DOES answer it, acknowledge that specifically, say what it establishes, and ask the next thing this phase actually needs.`;
}

/**
 * WHAT TO SAY WHEN THE EVIDENCE CANNOT EXIST YET.
 *
 * The founder asked for this in as many words: "I am asking you to help me
 * build the instrument that produces the scores, and to pre-register the
 * thresholds before I run it." The gate had spent seven attempts asking for the
 * scores instead.
 *
 * This does NOT soften the refusal — the phase is still closed, and the block
 * above it still stands. It redirects the one question the interviewer is
 * allowed to ask, from a value nobody has measured to the method that would
 * measure it. Pre-registering the threshold is the load-bearing half: a
 * threshold fixed after the data arrives can always be read backwards into a
 * pass.
 */
const FIELDWORK_INSTRUCTION =
  "WHAT IS LEFT CANNOT BE ANSWERED FROM MEMORY. Every criterion still open needs field data that does not exist yet, so do NOT ask the founder to score, estimate, guess or 'ballpark' any of it, and do not accept a number they produce on the spot — a figure invented to clear this gate is the exact fabrication this phase exists to prevent, and you would be the one who asked for it. Help them build the instrument instead: the recruiting plan, the sample size, the questions asked verbatim, and the pass/fail threshold committed to BEFORE any data arrives. Treat a defined protocol with a pre-registered threshold as real progress and say so — it is not a pass, and you must still not advance the phase, but it is the work that makes a pass possible.";

function blockedDirective(
  state: PhaseGateState,
  phase: PhaseDefinition
): string[] {
  const lines = [
    `${DIRECTIVE_HEADING} — as of last turn, BLOCKED on ${phaseLabel(phase)}.`,
    "",
    "The gate judged the conversation against this phase's exit criteria and refused to let the phase close.",
    "",
    VERDICT_VINTAGE,
  ];
  if (state.reason) {
    lines.push("", `Gate reason: ${state.reason}`);
  }
  const gaps = gapLines(state.missing);
  if (gaps.length > 0) {
    lines.push("", ...gaps);
  }
  lines.push(
    "",
    "You must not move the founder on to the next phase, must not tell them this phase is complete, and must not write a summary that reads as though the work is done — the gate decides that, and it has not. If the gap above is still open, say plainly and without padding that the phase is not closed, name the gap that matters most, and say what would close it. If their latest message just closed it, say what it establishes instead of restating the gap."
  );
  if (state.obstacle?.kind === "fieldwork-required") {
    lines.push("", FIELDWORK_INSTRUCTION);
  }
  if (state.attemptCount >= REPEAT_ATTEMPT_THRESHOLD) {
    lines.push(
      "",
      `This phase has now been judged ${state.attemptCount} times and is still short. Do not re-ask the same question in the same words — that is a deadlock, not persistence. Name the criterion that is blocking, say explicitly that the phase cannot close without it, and offer one concrete way to get that evidence, or one way to reframe the problem so a different answer becomes possible.`
    );
  }
  lines.push("", askLine(state.nextQuestion));
  return lines;
}

function warnedDirective(
  state: PhaseGateState,
  phase: PhaseDefinition
): string[] {
  const lines = [
    `${DIRECTIVE_HEADING} — as of last turn, ${phaseLabel(phase)} clears its blocking criteria but the gate flagged a weakness.`,
    "",
    VERDICT_VINTAGE,
  ];
  if (state.reason) {
    lines.push("", `Gate reason: ${state.reason}`);
  }
  const gaps = gapLines(state.missing);
  if (gaps.length > 0) {
    lines.push("", ...gaps);
  }
  lines.push(
    "",
    "Keep working inside this phase and keep the conversation moving — this is not a refusal. State the weakness above once, in one sentence, the first time it is relevant, and do not treat it as closed. You still may not tell the founder the phase is complete; the gate decides that, not you."
  );
  if (state.nextQuestion) {
    lines.push("", askLine(state.nextQuestion));
  }
  return lines;
}

function passedDirective(input: PhaseDirectiveInput): string[] {
  const { phase, state, nextPhase, workflowComplete } = input;
  const lines = [`${DIRECTIVE_HEADING} — ${phaseLabel(phase)} has PASSED.`];
  if (state?.reason) {
    lines.push("", `Gate reason: ${state.reason}`);
  }
  if (workflowComplete || !nextPhase) {
    lines.push(
      "",
      `All ${PHASE_COUNT} phases are complete. Say so in one sentence, state the single biggest remaining risk in the plan as it stands, and ask what the founder wants to work on. Do not restart the workflow and do not re-interrogate settled phases.`
    );
    return lines;
  }
  lines.push(
    "",
    `The founder now moves to ${phaseLabel(nextPhase)} — ${nextPhase.goal} Say in one sentence what phase ${phase.order} established, say in one sentence what this new phase decides, then ask the first question of the new phase. Do not relitigate phase ${phase.order}.`
  );
  return lines;
}

function openingDirective(input: PhaseDirectiveInput): string[] {
  const { phase, previousPhase } = input;
  if (previousPhase) {
    return [
      `${DIRECTIVE_HEADING} — ${phaseLabel(previousPhase)} is closed. The founder is now in ${phaseLabel(phase)}, which has not been judged yet.`,
      "",
      `Open it: one sentence on what phase ${previousPhase.order} established, one sentence on what this phase decides, then the first question of the brief above. Do not reopen phase ${previousPhase.order}.`,
    ];
  }
  return [
    `${DIRECTIVE_HEADING} — ${phaseLabel(phase)}. The gate has not judged this phase yet, so there is nothing to report back and nothing to refuse.`,
    "",
    "Work the brief above: ask one question at a time and wait for the answer. Do not claim the phase is complete and do not advance it — a separate gate decides that after each turn.",
  ];
}

/**
 * PURE. The whole point of the lane: turn the persisted verdict into the
 * instruction that shapes the next turn.
 *
 * Four branches, and each is reachable:
 *  - no verdict yet  → open the phase (turn 1, or the first turn of a new phase)
 *  - BLOCK           → refuse to advance, name the gap, ask the one question
 *  - WARN            → continue, but state the weakness once
 *  - PASS            → announce and move on, or finish the workflow
 *
 * The PASS branch is reached when the phase the founder is IN is passed, which
 * after a normal advance means the workflow is complete (the next phase becomes
 * current and has no verdict of its own). It is also the honest thing to render
 * if activation of the next phase ever failed, rather than silently re-blocking.
 */
export function buildPhaseDirective(input: PhaseDirectiveInput): string {
  const { state } = input;
  let lines: string[];
  if (state === null || state.decision === null) {
    lines = openingDirective(input);
  } else if (state.decision === "BLOCK") {
    lines = blockedDirective(state, input.phase);
  } else if (state.decision === "WARN") {
    lines = warnedDirective(state, input.phase);
  } else {
    lines = passedDirective(input);
  }
  return [...lines, "", STYLE_OVERRIDE].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// The assembled block.
// ─────────────────────────────────────────────────────────────────────────────

export type PhaseSystemBlockInput = {
  personaPrompt: string;
  phasePrompt: string;
  /** Pre-budgeted by lib/phases/context.ts. May be empty. */
  factBlock: string;
  directive: string;
};

export const PHASE_BLOCK_SEPARATOR = "\n\n---\n\n";

/**
 * PURE. Assembles the block that is appended to the chat system prompt.
 *
 * ORDER IS LOAD-BEARING. The directive goes LAST because the whole prompt is
 * base prompt → project instructions → this block, and the base prompt tells
 * the model to be long and to use tables. The refusal has to be the final word.
 *
 * Empty sections are dropped rather than rendered as empty headings — a missing
 * prompt file (loadPrompt degrades to "" instead of throwing) must not leave a
 * dangling separator that reads as a redacted instruction.
 */
export function buildPhaseSystemBlockText(
  input: PhaseSystemBlockInput
): string {
  return [
    input.personaPrompt,
    input.phasePrompt,
    input.factBlock,
    input.directive,
  ]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(PHASE_BLOCK_SEPARATOR);
}
