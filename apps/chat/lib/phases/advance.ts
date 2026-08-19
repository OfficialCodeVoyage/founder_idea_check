import { getPhaseByKey, getPhaseByOrder, PHASES } from "./definitions";
import type { GateDecisionValue, PhaseDefinition } from "./types";

/**
 * PHASE SEQUENCING — pure.
 *
 * Everything about "which phase is the project in" and "what happens on PASS"
 * lives here so it is decided by a function a test can call, not by an
 * `if (decision === "PASS")` buried in a DB write. lib/db/phase-queries.ts only
 * writes what these functions decide, exactly the way the SQL upsert only
 * writes what reconcileFacts() decides.
 *
 * DISCIPLINE: imports ./definitions and ./types only. No zod beyond what those
 * re-export, no DB, no model, no clock.
 */

/** The subset of a ProjectPhase row that sequencing actually reads. */
export type PhaseRowSummary = {
  phaseKey: string;
  status: "locked" | "active" | "passed";
};

export type CurrentPhaseResolution = {
  /** The phase the founder is in right now. Never undefined — see below. */
  phase: PhaseDefinition;
  /**
   * The phase immediately before `phase`, when it is recorded as passed. This
   * is what lets the very first turn of a new phase say "phase 1 is closed,
   * here is what phase 2 decides" instead of opening cold.
   */
  previousPhase: PhaseDefinition | null;
  nextPhase: PhaseDefinition | null;
  /** Every phase in PHASES is passed. `phase` is then the LAST phase. */
  workflowComplete: boolean;
};

/**
 * PURE. The current phase is the lowest-order phase that is not recorded as
 * passed.
 *
 * Read from `passed` rather than from `active` on purpose. "active" is written
 * by every gate run and by phase activation, so two rows can be active at once
 * after a crash between the two writes; "passed" is monotonic and only ever set
 * by a PASS verdict, so a prefix of passed phases is the one thing that cannot
 * be ambiguous. Rows for keys not in PHASES (a phase renamed since the row was
 * written) are ignored rather than trusted.
 *
 * When every phase is passed the workflow is COMPLETE, which is not an error:
 * it resolves to the last phase with workflowComplete true, and the directive
 * renderer says so. Returning undefined here would make the caller invent a
 * fallback, and the fallback would be phase 1 — i.e. finishing the workflow
 * would silently restart it.
 */
export function resolveCurrentPhase(
  rows: PhaseRowSummary[]
): CurrentPhaseResolution {
  const passed = new Set(
    rows.filter((r) => r.status === "passed").map((r) => r.phaseKey)
  );
  const ordered = [...PHASES].sort((a, b) => a.order - b.order);
  const current = ordered.find((p) => !passed.has(p.key));
  const lastPhase = ordered.at(-1) as PhaseDefinition;
  const phase = current ?? lastPhase;

  const previous = getPhaseByOrder(phase.order - 1) ?? null;
  return {
    phase,
    previousPhase: previous && passed.has(previous.key) ? previous : null,
    nextPhase: getPhaseByOrder(phase.order + 1) ?? null,
    workflowComplete: current === undefined,
  };
}

/** What the persistence layer must write after a gate verdict. */
export type PhaseAdvancePlan = {
  /** The row for the phase that was just judged. */
  current: {
    phaseKey: string;
    phaseOrder: number;
    status: "active" | "passed";
  };
  /** The phase to open next. NULL on WARN/BLOCK and at the end of the arc. */
  activate: { phaseKey: string; phaseOrder: number } | null;
  /** PASS on the final phase. Not an error — the arc is simply finished. */
  workflowComplete: boolean;
};

/**
 * PURE. Decides what a verdict does to the phase sequence.
 *
 * PASS and WARN advance. BLOCK does not.
 *
 * WARN advances because that is what "advisory" MEANS. types.ts defines the two
 * severities with a concrete example: "fewer than 5 people interviewed" (the
 * rubric's *investigate more* trigger) is advisory, while "nobody has tried a
 * workaround" (the rubric's explicit *Kill* trigger) is blocking. If WARN did
 * not advance, those two would be indistinguishable in effect, the `severity`
 * field would do nothing, and a founder who interviewed four people could never
 * proceed — the over-strict failure that kills retention just as surely as a
 * lenient gate makes the product a chat wrapper.
 *
 * The strictness lives entirely in the BLOCKING criteria (59 of them across the
 * eight phases, against 12 advisory), and those still hard-block — including
 * blocking criteria the judge marked only `partial`. Advancing on WARN does not
 * soften the gate; it stops advisory from silently meaning blocking.
 *
 * The gap stays visible: the WARN verdict, its reason and its missing[] are all
 * persisted on the row, and the directive renderer names the weakness once.
 */
export function planPhaseAdvance(
  phase: PhaseDefinition,
  decision: GateDecisionValue,
  /**
   * True when every phase is already passed. `passed` is only monotonic if
   * nothing ever writes over it: once the arc is finished, resolveCurrentPhase
   * reports the LAST phase as current, so a later BLOCK would otherwise write
   * status "active" back onto a passed row and silently un-finish a completed
   * workflow. A finished arc absorbs further verdicts without moving.
   */
  workflowComplete = false
): PhaseAdvancePlan {
  if (workflowComplete) {
    return {
      current: {
        phaseKey: phase.key,
        phaseOrder: phase.order,
        status: "passed",
      },
      activate: null,
      workflowComplete: true,
    };
  }

  if (decision === "BLOCK") {
    return {
      current: {
        phaseKey: phase.key,
        phaseOrder: phase.order,
        status: "active",
      },
      activate: null,
      workflowComplete: false,
    };
  }

  const next = getPhaseByOrder(phase.order + 1) ?? null;
  return {
    current: { phaseKey: phase.key, phaseOrder: phase.order, status: "passed" },
    activate: next ? { phaseKey: next.key, phaseOrder: next.order } : null,
    workflowComplete: next === null,
  };
}

/** PURE. True when `key` names a phase this build knows how to run. */
export function isKnownPhaseKey(key: string): boolean {
  return getPhaseByKey(key) !== undefined;
}
