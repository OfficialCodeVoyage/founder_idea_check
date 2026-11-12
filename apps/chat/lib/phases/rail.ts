import type {
  CriterionClosure,
  CriterionSeverity,
  CriterionStatus,
  GateDecisionValue,
  GateObstacle,
  GateObstacleKind,
} from "./types";

/**
 * WHAT THE GATE RAN INTO, said in the founder's language.
 *
 * The card used to print ONE headline — "WHAT IS MISSING" — over whatever
 * `missing` happened to contain. On attempts 2, 3, 4 and 7 of the live
 * problem-validation deadlock the text underneath said "could not be assessed",
 * so the founder read "WHAT IS MISSING: this could not be assessed" and had no
 * way to tell which of two opposite situations they were in:
 *
 *   the gate could not judge this   → say more, or say it differently
 *   you have not done this          → do it
 *   this cannot be known yet        → build the instrument that will know it
 *
 * Three states, three remedies, one headline. So the heading is per-arm and each
 * arm carries its own sentence.
 */
/**
 * `mixed` is not one of the gate's kinds. `obstacle.kind` names the LEADING
 * condition only — the rule that fired first — and since the gate began
 * reporting the whole open set rather than the deciding group, one list can
 * hold criteria the judge could not assess AND criteria it assessed as unmet.
 * "What could not be assessed" over five items it assessed perfectly well is a
 * smaller version of the bug that reporting the whole set was meant to end.
 */
export type GateObstacleViewKind = GateObstacleKind | "mixed";

export type GateObstacleView = {
  kind: GateObstacleViewKind;
  /** The list heading. Never the generic one. */
  heading: string;
  /** What this state IS and what closes it. Never blank. */
  note: string;
};

const OBSTACLE_VIEW: Record<
  GateObstacleViewKind,
  Omit<GateObstacleView, "kind">
> = {
  mixed: {
    heading: "What is still open",
    note: "These are not all the same kind of problem, and they do not have the same remedy. Some the gate could not tell either way — those usually need restating plainly rather than more work. The rest it could tell, and they are genuinely not met yet. The checklist below marks which is which.",
  },
  "phase-misconfigured": {
    heading: "What is wrong here",
    note: "This phase has no exit criteria, so it cannot be certified either way. That is a bug in the app, not something you did — nothing below tells you what to change.",
  },
  "judge-incomplete": {
    heading: "What went wrong",
    note: "The gate did not return a usable judgement, so this is not a finding about your work. Send another message and it will try again.",
  },
  "no-facts-yet": {
    heading: "Where to start",
    note: "Nothing has been established about this project yet, so there is nothing to judge against.",
  },
  "not-evaluable": {
    heading: "What could not be assessed",
    note: "The gate could not tell either way on these — which is NOT the same as you not having done them. Usually it means the transcript does not say clearly enough for a judgement to be made. Restating it plainly is often all this needs.",
  },
  "evidence-missing": {
    heading: "What is missing",
    note: "These are gaps you can close by answering — the evidence exists, it just has not been stated here yet.",
  },
  "fieldwork-required": {
    heading: "What cannot be known yet",
    note: "Everything still open needs data from outside this conversation, so there is no answer you could type that would honestly close it — and you should not be asked to invent one. The phase stays closed. The next real step is the instrument: who you will talk to, how many, what you will ask, and the pass/fail threshold you fix BEFORE you see any of it.",
  },
  "advisory-only": {
    heading: "What is thin",
    note: "Every blocking criterion is met. What is listed here weakens the finding without stopping it.",
  },
};

/**
 * Whether one heading can honestly cover this whole set.
 *
 * The only split that matters is `not-evaluable` against everything else: "the
 * gate could not tell" and "the gate could tell, and the answer is no" have
 * opposite remedies — say it again versus go and do it. A set of `unmet` and
 * `partial` together is not mixed in that sense; both are gaps the founder
 * closes by producing evidence, which is what the `evidence-missing` note says.
 *
 * A criterion id with no evaluation to look up is skipped rather than counted
 * as either side. Guessing there would be the same mistake one level down.
 */
function isMixedObstacle(
  obstacle: GateObstacle,
  perCriterion: readonly { criterionId: string; status: CriterionStatus }[]
): boolean {
  const status = new Map(perCriterion.map((e) => [e.criterionId, e.status]));
  const seen = obstacle.criterionIds
    .map((id) => status.get(id))
    .filter((value): value is CriterionStatus => value !== undefined);
  const unclear = seen.filter((value) => value === "not-evaluable").length;
  return unclear > 0 && unclear < seen.length;
}

/**
 * PURE. Null in, null out — an older stored verdict simply has no arm.
 *
 * `perCriterion` is OPTIONAL, and absent means "the caller does not track it",
 * never "the set is uniform". Without it the arm's own heading stands, which is
 * exactly what every verdict written before this check was rendered under.
 */
export function describeObstacle(
  obstacle: GateObstacle | null | undefined,
  perCriterion?: readonly { criterionId: string; status: CriterionStatus }[]
): GateObstacleView | null {
  if (!obstacle) {
    return null;
  }
  const kind: GateObstacleViewKind =
    perCriterion && isMixedObstacle(obstacle, perCriterion)
      ? "mixed"
      : obstacle.kind;
  return { kind, ...OBSTACLE_VIEW[kind] };
}

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
  /**
   * The judge's result per criterion, id and status only. The rail does not use
   * it; the card needs it to tell whether one heading can honestly cover the
   * whole obstacle set. Optional, and absence means the caller does not track
   * it — never that the set is uniform.
   */
  perCriterion?: readonly { criterionId: string; status: CriterionStatus }[];
  /**
   * Which rule fired. Optional and nullable for the same reason
   * `GateVerdictSchema.obstacle` is defaulted: every verdict written before this
   * field existed has none, and those must keep rendering as they did rather
   * than as a new kind of failure.
   */
  obstacle?: GateObstacle | null;
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
       * One stable, unique key per entry of `gaps`, for rendering.
       *
       * NOT the gap text: every criterion the judge left without a gap shares
       * the one `NO_GAP_NAMED` sentence, so text keys collide. The criterion
       * id when the verdict's obstacle names one per gap (the gate builds the
       * two lists from the same evaluations, in the same order), else `#<index>`.
       */
      gapKeys: readonly string[];
      /**
       * WHAT TO PRINT ABOVE THE LIST so the gaps are said exactly once.
       *
       * `reason` below is still the gate's own sentence, whole and unedited.
       * This is the rendering decision taken over it, and the arms are not
       * interchangeable — see `splitHeadline`.
       */
      headline: VerdictHeadline;
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
      /**
       * Which rule fired, ready to render. NULL for a verdict stored before the
       * arm existed — the card then falls back to its generic heading, which is
       * exactly what those verdicts were written under.
       */
      obstacle: GateObstacleView | null;
    };

/**
 * SAYING THE GAP ONCE.
 *
 * `decideGate` builds its reason as "<summary>: <every gap joined by '; '>." —
 * confirmed against all seven stored verdicts of the live problem-validation
 * deadlock. The card printed that sentence AND the same gaps as a list, so on
 * attempt 7, whose reason was
 *
 *   "1 of 8 exit criteria could not be assessed: four evidence-backed rubric
 *    scores to calculate the validation score."
 *
 * and whose `missing[0]` was the second half of it verbatim, half of a small
 * card was one sentence twice and the count appeared twice — on the single
 * surface whose whole job is to name the gap ONCE, clearly.
 *
 * It is worse on a long list. `sanitizeSentence` caps the reason at 300
 * characters, so attempt 1's five joined gaps arrive TRUNCATED MID-GAP, and
 * that truncated run-on sat above the same five gaps rendered properly.
 *
 * THE FIX IS TO SPLIT, NOT TO DROP. The reason's own summary half — "5 of 8
 * exit criteria are unmet" — is information the list does not carry, and the
 * list is the readable rendering the reason's tail is not. So the tail is cut
 * where the first gap begins and the two halves are printed once each.
 *
 * THE TEST IS THE TEXT, NEVER THE COUNT. Suppressing whenever `missing.length`
 * is 1 would delete the ordinary shape of a refusal — one named gap — which is
 * the one thing this card exists to show.
 */
export type VerdictHeadline =
  /** The gate wrote no reason. Nothing to print above the list. */
  | { kind: "none" }
  /** Print `text`, then the gap list under it. */
  | { kind: "summary"; text: string }
  /**
   * Print `text` and NOT the list: the reason is the gap and nothing else, so
   * the list underneath would be the same sentence a second time.
   */
  | { kind: "instead-of-list"; text: string };

/**
 * How much of a gap must appear verbatim in the reason to be its tail.
 *
 * A whole-string match is wrong here because the reason is capped at 300 chars
 * and the first gap can be cut in half by that cap. Forty characters of exact
 * agreement is not something two different sentences do by accident.
 */
const GAP_PROBE_LENGTH = 40;

/** Trailing punctuation left behind once the gap tail is cut off. */
const DANGLING = /[\s:;,\u2014-]+$/;

function splitHeadline(
  gaps: readonly string[],
  reason: string | null
): VerdictHeadline {
  if (!reason) {
    return { kind: "none" };
  }
  const first = gaps.at(0);
  if (!first) {
    return { kind: "summary", text: reason };
  }
  const probe = first.slice(0, GAP_PROBE_LENGTH);
  const at = probe.length > 0 ? reason.indexOf(probe) : -1;
  if (at < 0) {
    // The reason never quotes the gaps — nothing is being said twice.
    return { kind: "summary", text: reason };
  }
  const summary = reason.slice(0, at).replace(DANGLING, "");
  // Nothing but the gap itself was there, so there is no summary to keep and
  // the list would only repeat what is printed.
  return summary.length > 0
    ? { kind: "summary", text: summary }
    : { kind: "instead-of-list", text: reason };
}

function keysForGaps(
  gaps: readonly string[],
  obstacle: GateObstacle | null | undefined
): string[] {
  const ids = obstacle?.criterionIds ?? [];
  const aligned =
    ids.length === gaps.length && new Set(ids).size === ids.length;
  return gaps.map((_gap, index) => (aligned ? ids[index] : `#${index}`));
}

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
    gapKeys: keysForGaps(gaps, input.obstacle),
    headline: splitHeadline(gaps, input.reason ?? null),
    coverage,
    noGapNote,
    reason: input.reason ?? null,
    nextQuestion: input.nextQuestion ?? null,
    pending,
    obstacle: describeObstacle(input.obstacle, input.perCriterion),
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE FOUNDER STANDS: which attempt this is, what moved, what repeats.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Seven refusals arrived rendered IDENTICALLY and standalone. Nothing said this
 * was attempt 7, nothing said the same criterion had now blocked four of them,
 * and nothing said that four criteria had been closed and had re-opened twice
 * along the way — the counts went 5 -> 1 -> 1 -> 1 -> 5 -> 5 -> 1 and the
 * founder was told none of it. Every one of those facts was already in
 * `ProjectPhaseAttempt` and already computed by `describeAttemptSeries`; it was
 * rendered one navigation away, on a screen nobody in the middle of a refusal
 * opens.
 *
 * This turns that ledger into the three sentences the card needs. PURE: it
 * takes the series already computed in lib/phases/attempt-history.ts and
 * decides only what may honestly be SAID about it.
 */

/**
 * One attempt, projected down to what the card needs.
 *
 * `unmet` is NULL, never empty, when the attempt has no criterion state to
 * read — the verdict did not parse, or the gate failed closed and scored
 * nothing. An empty array there would mean "this attempt had no unmet
 * criteria", i.e. good news, which is the exact inversion `AttemptDetail`
 * exists to prevent.
 */
export type AttemptLedgerStep = {
  attemptNo: number;
  /**
   * What the gate decided on this attempt. Only a BLOCK blocked anything: a
   * WARN advanced with criteria still open, and calling those "blocked" would
   * name a refusal the gate never made.
   */
  decision: GateDecisionValue;
  /** Every criterion not marked met, advisory ones included. */
  unmet: readonly string[] | null;
  /** From describeAttemptSeries — the diff against the attempt before. */
  closed: readonly string[];
  opened: readonly string[];
  stillOpen: readonly string[];
};

export type CriterionRepeat = {
  criterionId: string;
  /**
   * Attempts ON RECORD that the gate BLOCKED with this criterion not met.
   * Blocking-severity criteria only: an advisory criterion can only ever
   * downgrade to WARN, so it never blocked anything and is never counted.
   */
  blocked: number;
  /**
   * Attempts on record that had criterion state at all — the denominator.
   *
   * NOT the attempt count. An attempt where the gate failed closed scored
   * nothing, and counting it as an attempt this criterion did NOT block would
   * quietly understate the repeat by claiming the gate had looked.
   */
  of: number;
};

export type AttemptProgress = {
  /** Criteria that stopped being unmet. What the founder actually fixed. */
  closed: readonly string[];
  /** REGRESSIONS: met before, not met now. The line nobody was ever shown. */
  opened: readonly string[];
  stillOpen: readonly string[];
};

export type AttemptStandingView = {
  /** "Attempt 7". NULL before the gate has ever run — never "Attempt 0". */
  attemptLabel: string | null;
  /**
   * The latest attempt's diff, or NULL when there is nothing to say.
   *
   * `describeAttemptSeries` writes three empty lists both when nothing changed
   * and when the two attempts could not be compared at all (an unreadable or
   * fail-closed verdict on either side). Rendering an all-empty diff would
   * assert "nothing moved" in a case where the truth is "this cannot be
   * compared", so the arm is null and the card says nothing instead.
   */
  progress: AttemptProgress | null;
  /** Criteria blocking NOW that have blocked before. Most-blocked first. */
  repeats: readonly CriterionRepeat[];
  /**
   * `repeats` as ONE sentence for the card body, or null when nothing repeats.
   *
   * Replayed against the seven real attempts, `repeats` has SEVEN entries, six
   * of them "blocked 7 of the 7". Printed as seven lines that is a wall of
   * identical text sitting on top of the regression, which is the one line on
   * the card the founder could not have worked out for themselves. Every repeat
   * is still shown — the checklist annotates each row — but the body gets one
   * sentence.
   */
  repeatNote: string | null;
};

/** Blocking once is a refusal. Blocking twice is a pattern worth naming. */
const REPEAT_THRESHOLD = 2;

/**
 * The criteria that BLOCKED this attempt: not met, blocking severity, on an
 * attempt the gate decided BLOCK. Empty for a WARN or PASS — open criteria on
 * an attempt that advanced did not block it. Deduped: a criterion listed twice
 * in one verdict is the judge's own defect and must not inflate any count.
 */
function blockersOf(
  attempt: AttemptLedgerStep,
  isBlocking: (criterionId: string) => boolean
): Set<string> {
  if (attempt.decision !== "BLOCK") {
    return new Set();
  }
  return new Set((attempt.unmet ?? []).filter(isBlocking));
}

function countRepeats(
  ledger: readonly AttemptLedgerStep[],
  criteria: readonly { id: string; severity: CriterionSeverity }[]
): CriterionRepeat[] {
  const latest = ledger.at(-1);
  // The card is showing the LATEST attempt. If that one scored nothing, saying
  // "this criterion is still blocking you" is a claim about work the gate never
  // looked at, so no repeat is reported at all.
  if (!latest?.unmet) {
    return [];
  }
  // Only a criterion the phase DEFINES as blocking. An id the definition no
  // longer carries has no known severity, and guessing "blocking" for it is how
  // an advisory criterion would end up called a blocker.
  const blockingIds = new Set(
    criteria.filter((c) => c.severity === "blocking").map((c) => c.id)
  );
  const isBlocking = (id: string) => blockingIds.has(id);
  const scored = ledger.filter((s) => s.unmet !== null);
  const blocked = new Map<string, number>();
  for (const attempt of scored) {
    for (const id of blockersOf(attempt, isBlocking)) {
      blocked.set(id, (blocked.get(id) ?? 0) + 1);
    }
  }
  return [...blockersOf(latest, isBlocking)]
    .map((criterionId) => ({
      criterionId,
      blocked: blocked.get(criterionId) ?? 0,
      of: scored.length,
    }))
    .filter((repeat) => repeat.blocked >= REPEAT_THRESHOLD)
    .sort((a, b) => b.blocked - a.blocked);
}

/** PURE. The ledger, said as position rather than as a list of refusals. */
export function describeAttemptStanding(input: {
  /**
   * `ProjectPhase.attemptCount` — how many times the gate has run on THIS
   * phase. Authoritative, and deliberately not `ledger.length`: verdicts
   * written before the ledger existed were overwritten and are gone, so the
   * ledger is sometimes the shorter of the two.
   */
  attemptCount: number;
  /** Oldest first, as describeAttemptSeries returns it. */
  ledger: readonly AttemptLedgerStep[];
  /** The phase's criteria: severity decides what can be called a blocker. */
  criteria: readonly { id: string; severity: CriterionSeverity }[];
}): AttemptStandingView {
  const repeats = countRepeats(input.ledger, input.criteria);
  return {
    attemptLabel:
      input.attemptCount > 0 ? `Attempt ${input.attemptCount}` : null,
    progress: latestProgress(input.ledger),
    repeats,
    repeatNote: repeatNote(repeats),
  };
}

function repeatNote(repeats: readonly CriterionRepeat[]): string | null {
  const top = repeats.at(0);
  if (!top) {
    return null;
  }
  const one = `${top.criterionId} has blocked ${top.blocked} of the ${top.of} attempts on record`;
  if (repeats.length === 1) {
    return `${one}.`;
  }
  return `${repeats.length} of the criteria still open have blocked more than one attempt — ${one}. The checklist below marks each of them.`;
}

function latestProgress(
  ledger: readonly AttemptLedgerStep[]
): AttemptProgress | null {
  const latest = ledger.at(-1);
  if (!latest) {
    return null;
  }
  const moved =
    latest.closed.length + latest.opened.length + latest.stillOpen.length;
  return moved > 0
    ? {
        closed: latest.closed,
        opened: latest.opened,
        stillOpen: latest.stillOpen,
      }
    : null;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ALL EIGHT EXIT CRITERIA, WITH THEIR STATE, WITHOUT LEAVING THE CONVERSATION.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The card names the blocking gap and nothing else, so through seven refusals
 * the founder never saw what they were being judged against — the full list
 * lives on the Phases screen, one navigation away from where the work happens.
 *
 * FIVE STATES, AND THE FIFTH IS THE IMPORTANT ONE. A criterion the judge did
 * not score is NOT unmet: `normalizeEvaluation` can drop an evaluation, and a
 * judge can return fewer than it was asked for. "Not met" is a finding about
 * the founder's work; "not scored" is a fact about the gate, and folding the
 * second into the first invents a refusal the gate never wrote.
 */
export type ChecklistCriterion = {
  id: string;
  description: string;
  severity: CriterionSeverity;
  closure: CriterionClosure;
};

export type ChecklistState = CriterionStatus | "unscored";

export type ChecklistRow = {
  id: string;
  description: string;
  severity: CriterionSeverity;
  closure: CriterionClosure;
  state: ChecklistState;
  /** The state in founder's words. Never blank, never shared between states. */
  label: string;
  /** Set only when this criterion has blocked more than one attempt. */
  repeat: CriterionRepeat | null;
};

/**
 * THE UNAVAILABLE ARM CARRIES NO ROWS.
 *
 * `failClosedVerdict` produces `perCriterion: []`, which means NOTHING WAS
 * JUDGED — not "eight criteria all came back untouched". Eight grey rows over
 * that verdict would tell a founder the gate looked at all eight and found
 * nothing to say, when the gate never ran. Same technique, and the same live
 * incident, as `GateVerdictView.coverage` above and `AttemptDetail` in
 * attempt-history.ts.
 */
export type CriterionChecklist =
  | { available: false; note: string }
  | {
      available: true;
      rows: readonly ChecklistRow[];
      /** "3 of 8 met, 2 not met…". Never a bare count with no states named. */
      summary: string;
      metCount: number;
      /** Rows the judge did not mark met. Includes the unscored ones. */
      openCount: number;
    };

const CHECKLIST_LABEL: Record<ChecklistState, string> = {
  met: "met",
  partial: "partly evidenced",
  unmet: "not met",
  "not-evaluable": "could not be assessed",
  unscored: "not scored on this attempt",
};

const NOTHING_SCORED =
  "The gate reached a decision without scoring a single criterion, so no criterion was scored on this attempt and none of them can be reported as met or unmet. This is a plumbing failure, not a finding about your work.";
const CANNOT_READ =
  "The stored verdict can no longer be read, so its per-criterion detail is unavailable. That is a reading failure — it is not a clean sheet.";
const NO_CRITERIA =
  "This phase defines no exit criteria, so there is nothing to check against. That is a bug in the app rather than something you did.";

function stateOf(
  id: string,
  perCriterion: readonly { criterionId: string; status: CriterionStatus }[]
): ChecklistState {
  return perCriterion.find((e) => e.criterionId === id)?.status ?? "unscored";
}

/** Counts of everything except `met`, in a stable order, as clauses. */
function openClauses(rows: readonly ChecklistRow[]): string[] {
  const order: ChecklistState[] = [
    "unmet",
    "partial",
    "not-evaluable",
    "unscored",
  ];
  return order
    .map((state) => ({
      state,
      count: rows.filter((r) => r.state === state).length,
    }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${CHECKLIST_LABEL[entry.state]}`);
}

function summarize(rows: readonly ChecklistRow[], metCount: number): string {
  const head = [`${metCount} of ${rows.length} met`, ...openClauses(rows)].join(
    ", "
  );
  // WHICH OF THE OPEN ONES CANNOT BE ANSWERED. "you have not said this" and
  // "nobody could say this yet" are different rows with opposite remedies, and
  // this sentence is the only place a collapsed checklist says so.
  const fieldwork = rows.filter(
    (r) => r.state !== "met" && r.closure === "offline-only"
  ).length;
  if (fieldwork === 0) {
    return `${head}.`;
  }
  const open = rows.length - metCount;
  return `${head}. ${fieldwork} of the ${open} still open need data from outside this conversation.`;
}

/** PURE. The eight rows, or an honest refusal to draw any. */
export function describeCriterionChecklist(input: {
  /** The phase's criteria, in definition order. */
  criteria: readonly ChecklistCriterion[];
  /** The judge's result per criterion — id and status only. */
  perCriterion: readonly { criterionId: string; status: CriterionStatus }[];
  /** Whether the stored verdict parsed at all. */
  verdictReadable: boolean;
  /** From describeAttemptStanding. Absent when nothing has repeated. */
  repeats?: readonly CriterionRepeat[];
}): CriterionChecklist {
  if (!input.verdictReadable) {
    return { available: false, note: CANNOT_READ };
  }
  if (input.criteria.length === 0) {
    return { available: false, note: NO_CRITERIA };
  }
  // perCriterion.length IS criteriaAssessed — toPhaseGateState derives one from
  // the other — so zero here is the fail-closed signature and nothing else.
  if (input.perCriterion.length === 0) {
    return { available: false, note: NOTHING_SCORED };
  }

  const repeats = input.repeats ?? [];
  const rows: ChecklistRow[] = input.criteria.map((c) => {
    const state = stateOf(c.id, input.perCriterion);
    return {
      id: c.id,
      description: c.description,
      severity: c.severity,
      closure: c.closure,
      state,
      label: CHECKLIST_LABEL[state],
      repeat: repeats.find((r) => r.criterionId === c.id) ?? null,
    };
  });
  const metCount = rows.filter((r) => r.state === "met").length;

  return {
    available: true,
    rows,
    summary: summarize(rows, metCount),
    metCount,
    openCount: rows.length - metCount,
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
