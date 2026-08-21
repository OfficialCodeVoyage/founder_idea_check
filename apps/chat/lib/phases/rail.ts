import type { GateDecisionValue } from "./types";

/**
 * WHAT THE PHASE RAIL SAYS, decided in one pure place.
 *
 * This is to the rail what `buildPhaseDirective` is to the system prompt and
 * `analyzeBlockers` is to the canvas. It imports only a type, so it is safe in
 * the client bundle.
 *
 * TWO DEFECTS LIVED IN THE COMPONENT BECAUSE THIS DID NOT EXIST:
 *
 * 1. `data.missing.at(0) ?? "no assessment yet — keep going"`. `decideGate`
 *    returns `missing: []` on BOTH of its PASS paths, so a PASS took the
 *    not-assessed fallback while the badge beside it independently read READY.
 *    After all eight gates passed the rail said
 *    "Phase 8 of 8 / READY / no assessment yet — keep going" while the export
 *    dialog correctly said COMPLETE. Two renderers of one fact, disagreeing.
 * 2. The rail sat a whole turn behind, because it refetched when the message
 *    count changed — i.e. at stream START — while the verdict is written by
 *    `runPostTurnPhasePass` inside `after()`, 15-30 seconds after the stream
 *    ENDS.
 *
 * FIVE STATES, KEPT APART. "Not assessed" is not "blocked", and a pass is not
 * an absence of findings. The status order below deliberately mirrors
 * `buildPhaseDirective`'s branch order (null -> BLOCK -> WARN -> PASS) so the
 * badge and the prompt the founder is reading can never contradict each other.
 */

export type RailStatus =
  | "unassessed"
  | "blocked"
  | "thin"
  | "passed"
  | "complete";

/**
 * Whether the rail is showing a verdict for the turn on screen.
 *
 * - `idle`       nothing pending; the badge is current.
 * - `waiting`    a turn just ended and the gate has not reported yet.
 * - `unreported` the wait hit its ceiling. The badge is the PREVIOUS verdict.
 */
export type RailAssessment = "idle" | "waiting" | "unreported";

const LABEL: Record<RailStatus, string> = {
  unassessed: "NOT ASSESSED",
  blocked: "BLOCKED",
  thin: "THIN",
  passed: "READY",
  complete: "COMPLETE",
};

/**
 * Used only when the gate reached a decision but named no specific gap. Distinct
 * per status, because "refused with no gap named" and "passed" are not the same
 * thing and must never share a string.
 */
const NO_GAP_BLOCK = "the gate refused this phase but named no specific gap";
const NO_GAP_WARN = "the gate flagged a weakness but named no specific gap";
const NOT_ASSESSED =
  "the gate has not assessed this phase yet — keep answering";
const PASSED = "this phase passed its gate";

export type RailPending = { marker: string; note: string };

const PENDING: Record<Exclude<RailAssessment, "idle">, RailPending> = {
  waiting: {
    marker: "checking…",
    note: "Checking for this turn's verdict. The gate runs after the answer has finished and takes up to half a minute; the badge below is the last verdict it wrote.",
  },
  unreported: {
    marker: "no verdict for this turn",
    note: "The gate did not report for this turn, so the badge is the verdict from an EARLIER turn — not a judgement of what you just said. This is not the same as being blocked. Send another message to try again.",
  },
};

export type RailDescription = {
  status: RailStatus;
  label: string;
  /** The one-line detail beside the badge. Never empty. */
  detail: string;
  /** Null when the rail is current. */
  pending: RailPending | null;
};

export type DescribeRailInput = {
  decision: GateDecisionValue | null;
  missing: readonly string[];
  workflowComplete: boolean;
  /** Total phases, for the completed-arc sentence. */
  total: number;
  assessment: RailAssessment;
  /**
   * The gate's own sentences. Optional because the RAIL does not use them — it
   * has no room — while `describeGateVerdict` below does. Both take one input
   * type so the two renderers cannot drift onto different payloads.
   */
  reason?: string | null;
  nextQuestion?: string | null;
  /**
   * `perCriterion.length` from the stored verdict, and whether it parsed. The
   * rail does not use them; the card must. Optional so `describeRail`'s callers
   * are unchanged — and defaulted below in the direction that OVER-reports
   * uncertainty rather than under-reporting it.
   */
  criteriaAssessed?: number;
  verdictReadable?: boolean;
};

function resolveStatus({
  decision,
  workflowComplete,
}: {
  decision: GateDecisionValue | null;
  workflowComplete: boolean;
}): RailStatus {
  // Mirrors buildPhaseDirective exactly: null -> BLOCK -> WARN -> PASS.
  //
  // WARN is checked BEFORE workflowComplete on purpose. `planPhaseAdvance`
  // advances on WARN, so a WARN on the last phase yields workflowComplete
  // true — and reporting that as COMPLETE would hide, on the arc's very last
  // verdict, that the gate had reservations.
  if (decision === null) {
    return "unassessed";
  }
  if (decision === "BLOCK") {
    return "blocked";
  }
  if (decision === "WARN") {
    return "thin";
  }
  return workflowComplete ? "complete" : "passed";
}

function resolveDetail({
  status,
  missing,
  total,
}: {
  status: RailStatus;
  missing: readonly string[];
  total: number;
}): string {
  const gap = missing.at(0);
  if (gap) {
    return gap;
  }
  switch (status) {
    case "unassessed":
      return NOT_ASSESSED;
    case "blocked":
      return NO_GAP_BLOCK;
    case "thin":
      return NO_GAP_WARN;
    case "complete":
      return `all ${total} phases passed their gate`;
    default:
      return PASSED;
  }
}

/** PURE. The whole rail, from the state the router already returns. */
export function describeRail(input: DescribeRailInput): RailDescription {
  const status = resolveStatus(input);
  return {
    status,
    label: LABEL[status],
    detail: resolveDetail({
      status,
      missing: input.missing,
      total: input.total,
    }),
    pending: input.assessment === "idle" ? null : PENDING[input.assessment],
  };
}

/**
 * THE FULL VERDICT, for the card in the transcript.
 *
 * `describeRail` above answers "what goes in a 36px strip", and to fit there it
 * shows `missing.at(0)` — the FIRST gap and no other. That is the right answer
 * for a rail and the wrong answer for the product: this app's claim is that the
 * gate refuses and names the gap, and a founder who is blocked on three
 * criteria could see exactly one of them, on hover, and had no way to learn the
 * rest without opening the canvas.
 *
 * This is the same decision, said in full. Both read the same
 * `phase.getState` payload, so the badge and the card cannot disagree.
 *
 * THE UNASSESSED ARM CARRIES NO VERDICT TO READ. No `status`, no `gaps`, no
 * `label` — so a caller cannot render "BLOCKED" for a phase the gate has not
 * looked at, and cannot reach for an empty gap list and conclude nothing was
 * wrong. Same technique as `SimulationNotAssessed` in
 * lib/research/simulation.ts, for the same reason.
 */
export type GateVerdictView =
  | {
      assessed: false;
      /** Why there is nothing to show. Never blank. */
      note: string;
      pending: RailPending | null;
    }
  | {
      assessed: true;
      status: Exclude<RailStatus, "unassessed">;
      label: string;
      /**
       * EVERY named gap, in order — but read `coverage` first.
       *
       * `missing` is NOT the criterion list. `decideGate` fills it per branch,
       * and `failClosedVerdict` (gate.ts:298) sets `missing: [reason]` with
       * `perCriterion: []`. Rendering that as "1 thing is missing" tells a
       * founder the gate found one gap when it actually never ran and every
       * criterion is still pending.
       */
      gaps: readonly string[];
      /**
       * Whether `gaps` can be trusted as a list of findings.
       *
       * - `scored`      the judge scored `criteria` criteria; gaps are real.
       * - `none-scored` the gate FAILED CLOSED. Nothing was judged. `gaps`
       *                 holds a plumbing message, not a finding about the work.
       * - `unreadable`  the stored verdict no longer parses, so `gaps` is empty
       *                 for a reason that is not "nothing was wrong".
       */
      coverage:
        | { kind: "scored"; criteria: number }
        | { kind: "none-scored" }
        | { kind: "unreadable" };
      /**
       * Set only when the gate reached a decision and named no gap at all.
       * Distinct per status, because "refused and named nothing" is a different
       * fact from "passed", and an empty `gaps` array alone cannot tell them
       * apart.
       */
      noGapNote: string | null;
      /** The gate's own words. Null when it wrote none. */
      reason: string | null;
      nextQuestion: string | null;
      pending: RailPending | null;
    };

/** PURE. The verdict card, from the state the router already returns. */
export function describeGateVerdict(input: DescribeRailInput): GateVerdictView {
  const pending =
    input.assessment === "idle" ? null : PENDING[input.assessment];
  const status = resolveStatus(input);

  if (status === "unassessed") {
    return { assessed: false, note: NOT_ASSESSED, pending };
  }

  const gaps = [...input.missing];
  let noGapNote: string | null = null;
  if (gaps.length === 0) {
    if (status === "blocked") {
      noGapNote = NO_GAP_BLOCK;
    } else if (status === "thin") {
      noGapNote = NO_GAP_WARN;
    }
  }

  // The defaults lean toward admitting uncertainty. `verdictReadable`
  // defaults true because an omitted flag means "the caller does not track
  // this", and claiming a verdict is unreadable when nobody said so would
  // invent a failure. `criteriaAssessed` defaults to the gap count, so an
  // older caller that passes neither still reports `scored` for a verdict that
  // named gaps, rather than accusing a working gate of having failed closed.
  const readable = input.verdictReadable ?? true;
  const scored = input.criteriaAssessed ?? gaps.length;
  let coverage: Extract<GateVerdictView, { assessed: true }>["coverage"];
  if (!readable) {
    coverage = { kind: "unreadable" };
  } else if (scored === 0) {
    coverage = { kind: "none-scored" };
  } else {
    coverage = { kind: "scored", criteria: scored };
  }

  return {
    assessed: true,
    status,
    label: LABEL[status],
    gaps,
    coverage,
    noGapNote,
    reason: input.reason ?? null,
    nextQuestion: input.nextQuestion ?? null,
    pending,
  };
}

/**
 * How long the rail waits for a verdict before admitting it did not arrive.
 *
 * The post-turn pass is three model calls; 15-30s measured. The old ladder
 * fired at 0/1.5/4/8s and always expired first.
 */
export const RAIL_POLL_INTERVAL_MS = 3000;
export const RAIL_POLL_CEILING_MS = 90_000;

/**
 * The rail's wait, as data.
 *
 * `baseline` is the `assessmentCount` observed when the wait began, so a landed
 * verdict is detected by that number CHANGING. It is `number | null`, never 0 —
 * a project with no verdicts genuinely has no baseline yet, and defaulting that
 * to 0 would make the first verdict indistinguishable from no verdict.
 */
export type RailWait =
  | { kind: "idle" }
  | { kind: "waiting"; baseline: number | null }
  | { kind: "unreported"; baseline: number | null };

export type RailWaitEvent =
  | { type: "turn-started" }
  | { type: "turn-ended"; count: number | null }
  | { type: "state-read"; count: number | null }
  | { type: "ceiling-reached" };

/**
 * PURE reducer for the wait.
 *
 * Returns the IDENTICAL object when nothing changes, so React bails out of the
 * re-render rather than looping on a new-but-equal state.
 *
 * `unreported` IS RECOVERABLE, and that is the important property. An earlier
 * design discarded the baseline at the ceiling and only cleared on the next
 * turn — so a wait that timed out because the tab was blurred would keep
 * asserting "no verdict for this turn" over a verdict that had since landed.
 * A note claiming the data is stale, printed on top of fresh data, is worse
 * than no note at all. So `state-read` clears BOTH waiting and unreported.
 */
export function advanceRailWait(
  wait: RailWait,
  event: RailWaitEvent
): RailWait {
  switch (event.type) {
    case "turn-started":
      return wait.kind === "waiting" && wait.baseline === null
        ? wait
        : { kind: "waiting", baseline: null };
    case "turn-ended":
      return { kind: "waiting", baseline: event.count };
    case "ceiling-reached":
      // Carry the baseline through, or recovery becomes impossible.
      return wait.kind === "waiting"
        ? { kind: "unreported", baseline: wait.baseline }
        : wait;
    case "state-read": {
      if (wait.kind === "idle") {
        return wait;
      }
      if (wait.baseline === null) {
        // First reading of the wait: adopt it, keep waiting.
        return { kind: wait.kind, baseline: event.count };
      }
      return event.count === wait.baseline ? wait : { kind: "idle" };
    }
    default:
      return wait;
  }
}
