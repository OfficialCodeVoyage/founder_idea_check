import {
  type GateDecisionValue,
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
};

/** Longest gap sentence that reaches the model. */
const MAX_GAP_LENGTH = 300;
/** Most gaps that reach the model. missing[0] is the one that matters. */
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
 * the caller can tell "not assessed yet" from "assessed and blocked". The rail
 * defaults a null decision to BLOCK (fail-closed UI); the SYSTEM PROMPT must
 * not copy that, or the first message of every project is refused with no gap
 * to name.
 */
export function toPhaseGateState(
  row: PhaseRowLike | null | undefined
): PhaseGateState | null {
  if (!row || row.decision === null || !DECISIONS.includes(row.decision)) {
    return null;
  }
  const parsed = GateVerdictSchema.safeParse(row.verdict);
  const missing = parsed.success
    ? parsed.data.missing
        .map(sanitizeGap)
        .filter((g) => g.length > 0)
        .slice(0, MAX_GAPS)
    : [];
  return {
    decision: row.decision as GateDecisionValue,
    reason: sanitizeSentence(row.reason),
    nextQuestion: sanitizeSentence(row.nextQuestion),
    missing,
    attemptCount: row.attemptCount,
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
 * The base system prompt (lib/ai/prompts.ts) mandates answers that are
 * "informative, long and very detailed" with "markdown format and tables too".
 * The phase brief mandates one question at a time. Both are in the same prompt,
 * and the base one comes first. Without this line a refusal arrives as a
 * 600-word markdown table about why the assistant is refusing.
 */
const STYLE_OVERRIDE =
  "Formatting override, and it outranks anything said earlier in this prompt: no tables, no headings, no bulleted essays, no long answers. A few sentences and then one question. Never ask two questions in one turn.";

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
  return ["What is still missing:", ...missing.map((g) => `- ${g}`)];
}

function askLine(nextQuestion: string | null): string {
  if (!nextQuestion) {
    return "Ask the single most useful question for closing the gap above, then stop and wait.";
  }
  return `Ask exactly this, rephrased into your own voice if it reads awkwardly but not weakened and not swapped for an easier one:\n"${nextQuestion}"\nThen stop and wait for the answer.`;
}

function blockedDirective(
  state: PhaseGateState,
  phase: PhaseDefinition
): string[] {
  const lines = [
    `${DIRECTIVE_HEADING} — BLOCKED on ${phaseLabel(phase)}.`,
    "",
    "The gate has judged the conversation so far against this phase's exit criteria and refused to let the phase close.",
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
    "You must not move the founder on to the next phase, must not tell them this phase is complete, and must not write a summary that reads as though the work is done. Say plainly and without padding that the phase is not closed, name the gap above that matters most, and say what would close it."
  );
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
    `${DIRECTIVE_HEADING} — ${phaseLabel(phase)} clears its blocking criteria but the gate flagged a weakness.`,
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
