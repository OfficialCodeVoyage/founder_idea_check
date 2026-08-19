import { describe, expect, it } from "vitest";
import {
  isKnownPhaseKey,
  type PhaseRowSummary,
  planPhaseAdvance,
  resolveCurrentPhase,
} from "./advance";
import { PHASES } from "./definitions";
import { PHASE_COUNT } from "./types";

const FIRST = PHASES[0];
const LAST = PHASES.at(-1) as (typeof PHASES)[number];

function passedThrough(order: number): PhaseRowSummary[] {
  return PHASES.filter((p) => p.order <= order).map((p) => ({
    phaseKey: p.key,
    status: "passed" as const,
  }));
}

describe("resolveCurrentPhase", () => {
  it("returns phase 1 for a project with no rows at all", () => {
    const r = resolveCurrentPhase([]);
    expect(r.phase.order).toBe(1);
    expect(r.previousPhase).toBeNull();
    expect(r.nextPhase?.order).toBe(2);
    expect(r.workflowComplete).toBe(false);
  });

  it("returns phase 1 while phase 1 is merely active", () => {
    const r = resolveCurrentPhase([
      { phaseKey: FIRST.key, status: "active" as const },
    ]);
    expect(r.phase.key).toBe(FIRST.key);
    expect(r.workflowComplete).toBe(false);
  });

  it("advances to phase 2 once phase 1 is passed, and names phase 1 as previous", () => {
    const r = resolveCurrentPhase(passedThrough(1));
    expect(r.phase.order).toBe(2);
    expect(r.previousPhase?.order).toBe(1);
    expect(r.nextPhase?.order).toBe(3);
    expect(r.workflowComplete).toBe(false);
  });

  it("does not report a previous phase when the preceding phase is not passed", () => {
    // A hand-edited/legacy state: phase 2 passed but phase 1 never was.
    const r = resolveCurrentPhase([
      { phaseKey: PHASES[1].key, status: "passed" as const },
    ]);
    expect(r.phase.order).toBe(1);
    expect(r.previousPhase).toBeNull();
  });

  it("resolves the LAST phase, with workflowComplete, when every phase is passed", () => {
    const r = resolveCurrentPhase(passedThrough(PHASE_COUNT));
    expect(r.phase.key).toBe(LAST.key);
    expect(r.nextPhase).toBeNull();
    expect(r.workflowComplete).toBe(true);
  });

  it("never restarts the workflow after completion", () => {
    // The bug a fallback-to-phase-1 would produce.
    expect(resolveCurrentPhase(passedThrough(PHASE_COUNT)).phase.order).toBe(
      PHASE_COUNT
    );
  });

  it("ignores rows whose phaseKey this build does not know", () => {
    const r = resolveCurrentPhase([
      { phaseKey: "phase-from-a-previous-schema", status: "passed" as const },
    ]);
    expect(r.phase.order).toBe(1);
  });

  it("reads passed, not active — two active rows cannot confuse it", () => {
    const rows: PhaseRowSummary[] = [
      { phaseKey: FIRST.key, status: "passed" },
      { phaseKey: PHASES[1].key, status: "active" },
      { phaseKey: PHASES[2].key, status: "active" },
    ];
    expect(resolveCurrentPhase(rows).phase.order).toBe(2);
  });

  it("is independent of row order", () => {
    const rows = passedThrough(3);
    const forward = resolveCurrentPhase(rows).phase.key;
    const reversed = resolveCurrentPhase([...rows].reverse()).phase.key;
    expect(reversed).toBe(forward);
  });

  it("walks 1 -> 8 as phases pass one at a time", () => {
    const seen: number[] = [];
    for (let passed = 0; passed < PHASE_COUNT; passed++) {
      seen.push(resolveCurrentPhase(passedThrough(passed)).phase.order);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("planPhaseAdvance", () => {
  it("PASS marks the phase passed and activates the next", () => {
    const plan = planPhaseAdvance(FIRST, "PASS");
    expect(plan.current).toEqual({
      phaseKey: FIRST.key,
      phaseOrder: 1,
      status: "passed",
    });
    expect(plan.activate).toEqual({ phaseKey: PHASES[1].key, phaseOrder: 2 });
    expect(plan.workflowComplete).toBe(false);
  });

  it("PASS on the LAST phase completes the workflow and is not an error", () => {
    const plan = planPhaseAdvance(LAST, "PASS");
    expect(plan.current.status).toBe("passed");
    expect(plan.activate).toBeNull();
    expect(plan.workflowComplete).toBe(true);
  });

  it("BLOCK keeps the phase active and activates nothing", () => {
    const plan = planPhaseAdvance(FIRST, "BLOCK");
    expect(plan.current.status).toBe("active");
    expect(plan.activate).toBeNull();
    expect(plan.workflowComplete).toBe(false);
  });

  /**
   * WARN advances because that is what "advisory" means. types.ts pairs the two
   * severities with a worked example: "fewer than 5 people interviewed" is
   * advisory, "nobody has tried a workaround" is blocking. If WARN held the
   * phase, those two would be identical in effect and a founder who interviewed
   * four people could never proceed. All the strictness lives in the 59
   * blocking criteria, which still hard-block.
   */
  it("WARN advances — advisory must not silently mean blocking", () => {
    const plan = planPhaseAdvance(FIRST, "WARN");
    expect(plan.current.status).toBe("passed");
    expect(plan.activate?.phaseOrder).toBe(2);
  });

  it("BLOCK holds the phase", () => {
    const plan = planPhaseAdvance(FIRST, "BLOCK");
    expect(plan.current.status).toBe("active");
    expect(plan.activate).toBeNull();
    expect(plan.workflowComplete).toBe(false);
  });

  /**
   * `passed` is only monotonic if nothing writes over it. Once the arc is
   * finished resolveCurrentPhase reports the LAST phase as current, so without
   * this guard a later BLOCK would write "active" onto a passed row and
   * silently un-finish a completed workflow.
   */
  it("a finished workflow absorbs later verdicts instead of un-finishing", () => {
    for (const decision of ["BLOCK", "WARN", "PASS"] as const) {
      const plan = planPhaseAdvance(FIRST, decision, true);
      expect(plan.current.status).toBe("passed");
      expect(plan.activate).toBeNull();
      expect(plan.workflowComplete).toBe(true);
    }
  });

  it("planning a PASS then resolving the written rows lands on the next phase", () => {
    const plan = planPhaseAdvance(FIRST, "PASS");
    const rows: PhaseRowSummary[] = [
      { phaseKey: plan.current.phaseKey, status: plan.current.status },
      ...(plan.activate
        ? [{ phaseKey: plan.activate.phaseKey, status: "active" as const }]
        : []),
    ];
    expect(resolveCurrentPhase(rows).phase.order).toBe(2);
  });
});

describe("isKnownPhaseKey", () => {
  it("accepts every defined phase key", () => {
    for (const phase of PHASES) {
      expect(isKnownPhaseKey(phase.key)).toBe(true);
    }
  });

  it("rejects an unknown key", () => {
    expect(isKnownPhaseKey("not-a-phase")).toBe(false);
  });
});
