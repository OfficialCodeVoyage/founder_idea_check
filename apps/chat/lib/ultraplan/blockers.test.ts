import { describe, expect, it } from "vitest";
import { PHASE_ONE } from "@/lib/phases/definitions";
import type {
  CriterionEvaluation,
  CriterionStatus,
  ExitCriterion,
  GateVerdict,
} from "@/lib/phases/types";
import { analyzeBlockers } from "./blockers";

/**
 * Every test here runs with no model, no DB and no network — that is the point
 * of keeping blockers.ts pure. `env -u AI_GATEWAY_API_KEY -u OPENAI_API_KEY
 * -u ANTHROPIC_API_KEY bunx vitest run lib/ultraplan` must pass.
 */

const PHASE_KEY = "problem-validation";

/** A small hand-built phase, so the assertions do not move when phase copy does. */
const CRITERIA: ExitCriterion[] = [
  {
    id: "problem-statement",
    type: "artifact-exists",
    severity: "blocking",
    description: "A one-sentence problem statement naming who has the problem.",
    factKey: "problem_statement",
  },
  {
    id: "validation-score",
    type: "metric-threshold",
    severity: "blocking",
    description: "The rubric score must reach the investigate-further band.",
    metric: "validation_score",
    operator: "≥",
    threshold: 100,
  },
  {
    id: "people-interviewed",
    type: "metric-threshold",
    severity: "advisory",
    description: "Five or more people interviewed about the problem.",
    metric: "people_interviewed",
    operator: "≥",
    threshold: 5,
  },
];

const DEFAULT_CONFIDENCE = 80;

function defaultGap(criterionId: string, status: CriterionStatus) {
  return status === "met" ? null : `${criterionId} has no evidence`;
}

function ev(
  criterionId: string,
  status: CriterionStatus,
  extra: Partial<CriterionEvaluation> = {}
): CriterionEvaluation {
  return {
    criterionId,
    status,
    evidence: extra.evidence ?? "the founder said so",
    gap: extra.gap === undefined ? defaultGap(criterionId, status) : extra.gap,
    nextQuestion: extra.nextQuestion ?? null,
    confidence: extra.confidence ?? DEFAULT_CONFIDENCE,
  };
}

function verdict(
  decision: GateVerdict["decision"],
  perCriterion: CriterionEvaluation[],
  extra: Partial<GateVerdict> = {}
): GateVerdict {
  return {
    decision,
    perCriterion,
    missing: extra.missing ?? perCriterion.map((e) => e.gap ?? ""),
    nextQuestion: extra.nextQuestion ?? null,
    reason: extra.reason ?? `decision ${decision}`,
  };
}

function analyze(v: GateVerdict | null, criteria: ExitCriterion[] = CRITERIA) {
  return analyzeBlockers({ phaseKey: PHASE_KEY, criteria, verdict: v });
}

describe("analyzeBlockers — the never-assessed state", () => {
  it("reports 'unassessed', not 'blocked', when the gate has never run", () => {
    const analysis = analyze(null);

    // This is the whole reason the module exists: "we have not looked yet" and
    // "we looked and you are blocked" must not share a rendering. The rail
    // draws the same distinction in describeRail (lib/phases/rail.ts).
    expect(analysis.state).toBe("unassessed");
    expect(analysis.state).not.toBe("blocked");
    expect(analysis.decision).toBeNull();
    expect(analysis.reason).toBeNull();
  });

  it("invents no blockers and no tasks for a project it has not assessed", () => {
    const analysis = analyze(null);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.tasks).toEqual([]);
  });
});

describe("analyzeBlockers — assessed states", () => {
  it("reports 'clear' only when every criterion is met", () => {
    const analysis = analyze(
      verdict(
        "PASS",
        CRITERIA.map((c) => ev(c.id, "met"))
      )
    );
    expect(analysis.state).toBe("clear");
    expect(analysis.blockers).toEqual([]);
    expect(analysis.decision).toBe("PASS");
  });

  it("reports 'blocked' with a blocking gap and passes the gate's reason through", () => {
    const analysis = analyze(
      verdict(
        "BLOCK",
        [
          ev("problem-statement", "unmet", {
            gap: "no problem statement has been given",
            nextQuestion: "Who has this problem, and how often?",
          }),
          ev("validation-score", "met"),
          ev("people-interviewed", "met"),
        ],
        { reason: "1 of 3 exit criteria are unmet" }
      )
    );

    expect(analysis.state).toBe("blocked");
    expect(analysis.reason).toBe("1 of 3 exit criteria are unmet");
    expect(analysis.blockers).toHaveLength(1);

    const [blocker] = analysis.blockers;
    expect(blocker.id).toBe(`${PHASE_KEY}::problem-statement`);
    expect(blocker.blocker).toBe("no problem statement has been given");
    expect(blocker.severity).toBe("blocking");
    expect(blocker.blocksAdvance).toBe(true);
    expect(blocker.status).toBe("unmet");
  });

  it("treats a blocking PARTIAL as a blocker, matching decideGate's default", () => {
    const analysis = analyze(
      verdict("BLOCK", [
        ev("problem-statement", "partial", { gap: "no named user" }),
        ev("validation-score", "met"),
        ev("people-interviewed", "met"),
      ])
    );
    expect(analysis.blockers).toHaveLength(1);
    expect(analysis.blockers[0].severity).toBe("blocking");
    expect(analysis.blockers[0].status).toBe("partial");
  });

  it("keeps an advisory miss advisory, and does not let it block advance", () => {
    const analysis = analyze(
      verdict("WARN", [
        ev("problem-statement", "met"),
        ev("validation-score", "met"),
        ev("people-interviewed", "partial", {
          gap: "only 2 people interviewed",
        }),
      ])
    );
    expect(analysis.state).toBe("advisory");
    expect(analysis.blockers).toHaveLength(1);
    expect(analysis.blockers[0].severity).toBe("advisory");
    expect(analysis.blockers[0].blocksAdvance).toBe(false);
  });

  it("never marks anything blocksAdvance under a WARN, whatever the severity", () => {
    // The gate has already let the founder through. A red "blocks advance" flag
    // on a phase the gate is waving through is a contradiction the founder
    // cannot resolve.
    const analysis = analyze(
      verdict("WARN", [
        ev("problem-statement", "partial", { gap: "thin" }),
        ev("validation-score", "met"),
        ev("people-interviewed", "met"),
      ])
    );
    expect(analysis.blockers.every((b) => b.blocksAdvance === false)).toBe(
      true
    );
  });
});

describe("analyzeBlockers — fail-closed rules", () => {
  it("marks a not-evaluable criterion 'unknown', never blocking and never met", () => {
    const analysis = analyze(
      verdict("BLOCK", [
        ev("problem-statement", "not-evaluable", {
          gap: "the transcript does not mention the problem at all",
        }),
        ev("validation-score", "met"),
        ev("people-interviewed", "met"),
      ])
    );
    expect(analysis.blockers).toHaveLength(1);
    expect(analysis.blockers[0].severity).toBe("unknown");
    // Uncertain AND blocking: the two facts are carried by different fields.
    expect(analysis.blockers[0].blocksAdvance).toBe(true);
  });

  it("downgrades a gapless non-met verdict to 'unknown' rather than trusting it", () => {
    // gate.ts's normalizeEvaluation() enforces "a non-met status must name a
    // gap", but a verdict read back out of the `verdict` json column has never
    // been through that function.
    const analysis = analyze(
      verdict("BLOCK", [
        ev("problem-statement", "unmet", { gap: null }),
        ev("validation-score", "met"),
        ev("people-interviewed", "met"),
      ])
    );
    expect(analysis.blockers[0].severity).toBe("unknown");
    expect(analysis.blockers[0].blocker).toContain("named no specific gap");
  });

  it("reports every uncovered criterion when the gate failed closed", () => {
    // failClosedVerdict() emits BLOCK with perCriterion: []. Skipping what the
    // judge did not mention would render a blocked phase as an empty, clean
    // board.
    const analysis = analyze(
      verdict("BLOCK", [], {
        reason: "Gate failed closed: the judge call failed",
      })
    );
    expect(analysis.state).toBe("blocked");
    expect(analysis.blockers).toHaveLength(CRITERIA.length);
    expect(analysis.blockers.every((b) => b.severity === "unknown")).toBe(true);
    expect(analysis.blockers.every((b) => b.status === "not-evaluable")).toBe(
      true
    );
  });

  it("keeps blocksAdvance true for blocking criteria the judge never covered", () => {
    const analysis = analyze(verdict("BLOCK", []));
    const advisory = analysis.blockers.find(
      (b) => b.criterionId === "people-interviewed"
    );
    const blocking = analysis.blockers.find(
      (b) => b.criterionId === "problem-statement"
    );
    expect(blocking?.blocksAdvance).toBe(true);
    expect(advisory?.blocksAdvance).toBe(false);
  });

  it("surfaces a criterion the phase does not define instead of ignoring it", () => {
    const analysis = analyze(
      verdict("BLOCK", [
        ev("problem-statement", "met"),
        ev("validation-score", "met"),
        ev("people-interviewed", "met"),
        ev("invented-criterion", "unmet", { gap: "who knows" }),
      ])
    );
    const stray = analysis.blockers.find(
      (b) => b.criterionId === "invented-criterion"
    );
    expect(stray).toBeDefined();
    expect(stray?.severity).toBe("unknown");
    // Fail closed the same way gate.ts does with `severityOf.get(id) ?? "blocking"`.
    expect(stray?.blocksAdvance).toBe(true);
  });

  it("does not report a PASS with unchecked criteria as 'clear'", () => {
    // A PASS produced by `gate.enabled: false` can carry an empty perCriterion.
    // Reporting that as "clear" hides an operator opt-out behind a green badge.
    const analysis = analyze(verdict("PASS", []));
    expect(analysis.state).toBe("advisory");
    expect(analysis.blockers).toHaveLength(CRITERIA.length);
    expect(analysis.blockers.every((b) => b.blocksAdvance === false)).toBe(
      true
    );
  });
});

describe("analyzeBlockers — unblocking tasks", () => {
  it("turns the judge's next question into the first task", () => {
    const analysis = analyze(
      verdict("BLOCK", [
        ev("problem-statement", "unmet", {
          gap: "no problem statement",
          nextQuestion: "What breaks today, and for whom?",
        }),
        ev("validation-score", "met"),
        ev("people-interviewed", "met"),
      ])
    );
    const tasks = analysis.blockers[0].unblockingTasks;
    expect(tasks[0].kind).toBe("answer-question");
    expect(tasks[0].title).toBe("Answer: What breaks today, and for whom?");
    expect(tasks[0].detail).toBe("no problem statement");
  });

  it("derives the target task from the criterion type, not from prose", () => {
    const analysis = analyze(
      verdict("BLOCK", [
        ev("problem-statement", "unmet", { gap: "missing" }),
        ev("validation-score", "unmet", { gap: "score not computed" }),
        ev("people-interviewed", "met"),
      ])
    );
    const [factTask] = analysis.blockers
      .filter((b) => b.criterionId === "problem-statement")
      .flatMap((b) => b.unblockingTasks);
    expect(factTask.kind).toBe("establish-fact");
    expect(factTask.title).toBe('Establish "problem_statement"');
    expect(factTask.producesFactKey).toBe("problem_statement");

    const [metricTask] = analysis.blockers
      .filter((b) => b.criterionId === "validation-score")
      .flatMap((b) => b.unblockingTasks);
    expect(metricTask.kind).toBe("raise-metric");
    expect(metricTask.title).toBe("Move validation_score to ≥ 100");
    expect(metricTask.producesFactKey).toBe("validation_score");
  });

  it("asks for evidence, never for a fix, when the gate could not assess", () => {
    // "Establish fact X" asserts that X is missing. When the gate could not
    // read the criterion we do not know that, so the confident task would be
    // the canvas inventing a gap the gate never found.
    const analysis = analyze(
      verdict("BLOCK", [
        ev("problem-statement", "not-evaluable", { gap: "unreadable" }),
        ev("validation-score", "met"),
        ev("people-interviewed", "met"),
      ])
    );
    const kinds = analysis.blockers[0].unblockingTasks.map((t) => t.kind);
    expect(kinds).toContain("supply-evidence");
    expect(kinds).not.toContain("establish-fact");
  });

  it("emits at most two tasks per blocker", () => {
    const analysis = analyze(
      verdict(
        "BLOCK",
        CRITERIA.map((c) =>
          ev(c.id, "unmet", { gap: `${c.id} gap`, nextQuestion: "Why?" })
        )
      )
    );
    for (const blocker of analysis.blockers) {
      expect(blocker.unblockingTasks.length).toBeLessThanOrEqual(2);
      expect(blocker.unblockingTasks.length).toBeGreaterThan(0);
    }
  });

  it("flattens tasks with unique ids namespaced by phase and criterion", () => {
    const analysis = analyze(
      verdict(
        "BLOCK",
        CRITERIA.map((c) => ev(c.id, "unmet", { gap: `${c.id} gap` }))
      )
    );
    const ids = analysis.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith(`${PHASE_KEY}::`))).toBe(true);
  });
});

describe("analyzeBlockers — ordering and determinism", () => {
  it("orders blocking, then unknown, then advisory", () => {
    const analysis = analyze(
      verdict("BLOCK", [
        ev("people-interviewed", "unmet", { gap: "only 2 interviewed" }),
        ev("validation-score", "not-evaluable", { gap: "no score visible" }),
        ev("problem-statement", "unmet", { gap: "no statement" }),
      ])
    );
    expect(analysis.blockers.map((b) => b.severity)).toEqual([
      "blocking",
      "unknown",
      "advisory",
    ]);
  });

  it("breaks severity ties on definition order, never on judge output order", () => {
    const forward = analyze(
      verdict("BLOCK", [
        ev("problem-statement", "unmet", { gap: "a" }),
        ev("validation-score", "unmet", { gap: "b" }),
        ev("people-interviewed", "met"),
      ])
    );
    const reversed = analyze(
      verdict("BLOCK", [
        ev("validation-score", "unmet", { gap: "b" }),
        ev("problem-statement", "unmet", { gap: "a" }),
        ev("people-interviewed", "met"),
      ])
    );
    expect(forward.blockers.map((b) => b.criterionId)).toEqual([
      "problem-statement",
      "validation-score",
    ]);
    expect(reversed.blockers.map((b) => b.criterionId)).toEqual(
      forward.blockers.map((b) => b.criterionId)
    );
  });

  it("is a total function of its input — same verdict, identical output", () => {
    const input = verdict("BLOCK", [
      ev("problem-statement", "unmet", { gap: "a", nextQuestion: "Who?" }),
      ev("validation-score", "partial", { gap: "b" }),
      ev("people-interviewed", "not-evaluable", { gap: "c" }),
    ]);
    expect(analyze(input)).toEqual(analyze(input));
  });
});

describe("analyzeBlockers — against the real phase 1 definition", () => {
  it("produces one unknown blocker per criterion for a fail-closed verdict", () => {
    const analysis = analyzeBlockers({
      phaseKey: PHASE_ONE.key,
      criteria: PHASE_ONE.exitCriteria,
      verdict: verdict("BLOCK", [], {
        reason: "Gate failed closed: the judge call failed",
      }),
    });
    expect(analysis.blockers).toHaveLength(PHASE_ONE.exitCriteria.length);
    expect(analysis.state).toBe("blocked");
    expect(analysis.tasks.length).toBeGreaterThan(0);
    expect(analysis.tasks.every((t) => t.kind === "supply-evidence")).toBe(
      true
    );
  });

  it("treats phase 1's advisory people-interviewed criterion as advisory", () => {
    const analysis = analyzeBlockers({
      phaseKey: PHASE_ONE.key,
      criteria: PHASE_ONE.exitCriteria,
      verdict: verdict(
        "WARN",
        PHASE_ONE.exitCriteria.map((c) =>
          c.id === "people-interviewed"
            ? ev(c.id, "partial", { gap: "only 2 people interviewed" })
            : ev(c.id, "met")
        )
      ),
    });
    expect(analysis.state).toBe("advisory");
    expect(analysis.blockers).toHaveLength(1);
    expect(analysis.blockers[0].severity).toBe("advisory");
  });
});
