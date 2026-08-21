import { resolveCurrentPhase } from "./advance";
import { PHASES } from "./definitions";
import { toPhaseGateState } from "./directive";
import type { GateDecisionValue, PhaseDefinition } from "./types";

/**
 * THE EIGHT PHASES, AS A LIST A FOUNDER CAN READ.
 *
 * Until this existed, no screen in the app named a single phase. The rail said
 * "Phase 3 of 8" and a founder had no way to learn what 4 through 8 were, what
 * this one required, or how many times the gate had already refused them —
 * `PHASES` was imported by the export builder and the sequencer and by no
 * component at all.
 *
 * PURE. Takes rows, returns a roster. No database, no clock, no React — the
 * same shape as `describeRail` and `analyzeBlockers`, and testable the way this
 * repo tests everything that decides something.
 */

/**
 * What the gate has said about one phase.
 *
 * THE UNASSESSED ARM HAS NO `decision` TO READ. A phase nobody has judged is
 * not blocked, and a renderer must not be able to reach for a decision that
 * does not exist. Same technique as `SimulationNotAssessed` and
 * `GateVerdictView`, for the same reason.
 *
 * `no-row` and `no-verdict` are kept apart deliberately: a phase the workflow
 * has never opened and a phase that is open but unjudged are different facts,
 * and a founder reading "why is this blank" deserves the right one.
 */
export type PhaseRosterGate =
  | { assessed: false; why: "no-row" | "no-verdict" }
  | {
      assessed: true;
      decision: GateDecisionValue;
      reason: string | null;
      nextQuestion: string | null;
      /** Ordered gap sentences. See the caveat on `verdictReadable`. */
      missing: readonly string[];
      /** Criteria the judge actually scored. 0 means it failed closed. */
      criteriaAssessed: number;
      /**
       * False when the stored verdict no longer parses. `missing` is then empty
       * for a reason that is NOT "nothing was wrong", and the UI must say so.
       */
      verdictReadable: boolean;
    };

export type PhaseRosterEntry = {
  key: string;
  title: string;
  order: number;
  goal: string;
  /** How many exit criteria this phase declares. */
  criteriaCount: number;
  /** Where this phase sits relative to the one the founder is on. */
  position: "passed" | "current" | "later";
  /**
   * How many times the gate has run on this phase. 0 when it has never opened.
   * Read as a count of attempts, which on a passed phase includes the refusals
   * that came before the pass — that is the number worth seeing.
   */
  attemptCount: number;
  gate: PhaseRosterGate;
};

export type PhaseRosterRow = {
  phaseKey: string;
  status: string;
  decision: string | null;
  reason: string | null;
  nextQuestion: string | null;
  verdict: unknown;
  attemptCount: number;
};

/** PURE. Every phase, in order, whether or not the project has reached it. */
export function describePhaseRoster(
  rows: readonly PhaseRosterRow[]
): PhaseRosterEntry[] {
  const byKey = new Map(rows.map((row) => [row.phaseKey, row]));

  // The SAME resolver the rail and the system prompt use, so the roster cannot
  // disagree with them about which phase is current.
  const { phase: currentPhase } = resolveCurrentPhase(
    rows.map((row) => ({
      phaseKey: row.phaseKey,
      status: row.status as "locked" | "active" | "passed",
    }))
  );

  const ordered = [...PHASES].sort(
    (a: PhaseDefinition, b: PhaseDefinition) => a.order - b.order
  );

  return ordered.map((phase) => {
    const row = byKey.get(phase.key) ?? null;
    return {
      key: phase.key,
      title: phase.title,
      order: phase.order,
      goal: phase.goal,
      criteriaCount: phase.exitCriteria.length,
      position: resolvePosition(phase, row, currentPhase.key),
      attemptCount: row?.attemptCount ?? 0,
      gate: resolveGate(row),
    };
  });
}

function resolvePosition(
  phase: PhaseDefinition,
  row: PhaseRosterRow | null,
  currentKey: string
): PhaseRosterEntry["position"] {
  // `passed` comes off the ROW, not the order, because a WARN advances the
  // workflow: a phase can be behind the current one without having passed
  // cleanly, and calling that "passed" by position would hide the reservation.
  if (row?.status === "passed") {
    return "passed";
  }
  return phase.key === currentKey ? "current" : "later";
}

function resolveGate(row: PhaseRosterRow | null): PhaseRosterGate {
  if (!row) {
    return { assessed: false, why: "no-row" };
  }
  // `toPhaseGateState` returns null for a row whose decision is absent or not a
  // known decision — reuse it rather than re-deriving "has this been judged",
  // which is exactly the kind of second opinion that drifts.
  const state = toPhaseGateState(row);
  if (!state?.decision) {
    return { assessed: false, why: "no-verdict" };
  }
  return {
    assessed: true,
    decision: state.decision,
    reason: state.reason,
    nextQuestion: state.nextQuestion,
    missing: state.missing,
    criteriaAssessed: state.criteriaAssessed,
    verdictReadable: state.verdictReadable,
  };
}
