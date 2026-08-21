import { describe, expect, it } from "vitest";
import { PHASES } from "./definitions";
import { describePhaseRoster, type PhaseRosterRow } from "./roster";

const ORDERED = [...PHASES].sort((a, b) => a.order - b.order);

function verdict(over: Record<string, unknown> = {}) {
  return {
    decision: "BLOCK",
    perCriterion: [
      { criterionId: "problem-statement", status: "met", evidence: "…" },
      { criterionId: "who-has-it", status: "unmet", gap: "no evidenced buyer" },
    ],
    missing: ["no evidenced buyer"],
    nextQuestion: "Who told you this?",
    reason: "1 blocking criterion is unmet.",
    ...over,
  };
}

function row(over: Partial<PhaseRosterRow> = {}): PhaseRosterRow {
  return {
    phaseKey: ORDERED[0].key,
    status: "active",
    decision: "BLOCK",
    reason: "1 blocking criterion is unmet.",
    nextQuestion: "Who told you this?",
    verdict: verdict(),
    attemptCount: 1,
    ...over,
  };
}

describe("describePhaseRoster — every phase, named", () => {
  it("returns all eight phases even for a project with no rows at all", () => {
    // A founder on turn one must still be able to read what is coming. Before
    // this, no screen named a single phase.
    const roster = describePhaseRoster([]);
    expect(roster).toHaveLength(ORDERED.length);
    expect(roster.map((entry) => entry.key)).toEqual(
      ORDERED.map((phase) => phase.key)
    );
    for (const entry of roster) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.criteriaCount).toBeGreaterThan(0);
    }
  });

  it("does NOT report an unopened phase as blocked, in any form", () => {
    // The whole point. "Never judged" is not "refused", and the arm carries no
    // decision for a renderer to reach for.
    const roster = describePhaseRoster([]);
    for (const entry of roster) {
      expect(entry.gate.assessed).toBe(false);
      expect("decision" in entry.gate).toBe(false);
      expect(entry.attemptCount).toBe(0);
    }
  });

  it("keeps 'never opened' apart from 'open but unjudged'", () => {
    const roster = describePhaseRoster([
      row({ decision: null, verdict: null, attemptCount: 0 }),
    ]);
    const first = roster[0].gate;
    const second = roster[1].gate;
    expect(first.assessed).toBe(false);
    expect(second.assessed).toBe(false);
    if (!(first.assessed || second.assessed)) {
      expect(first.why).toBe("no-verdict");
      expect(second.why).toBe("no-row");
    }
  });

  it("surfaces the attempt count, including on a phase that eventually passed", () => {
    // go-to-market took four attempts in the dev data. Three of those were
    // refusals a founder has never been able to see.
    const roster = describePhaseRoster([
      row({ status: "passed", decision: "PASS", attemptCount: 4 }),
    ]);
    expect(roster[0].attemptCount).toBe(4);
    expect(roster[0].position).toBe("passed");
  });

  it("marks the current phase using the same resolver as the rail", () => {
    const roster = describePhaseRoster([
      row({ phaseKey: ORDERED[0].key, status: "passed", decision: "PASS" }),
      row({ phaseKey: ORDERED[1].key, status: "active" }),
    ]);
    expect(roster[0].position).toBe("passed");
    expect(roster[1].position).toBe("current");
    expect(roster[2].position).toBe("later");
  });

  it("does not call a WARN-advanced phase passed by position alone", () => {
    // A WARN advances the workflow. Reporting the phase behind the current one
    // as "passed" purely because it is behind would hide the reservation.
    const roster = describePhaseRoster([
      row({ phaseKey: ORDERED[0].key, status: "active", decision: "WARN" }),
      row({ phaseKey: ORDERED[1].key, status: "active" }),
    ]);
    expect(roster[0].position).not.toBe("passed");
  });

  it("reports a fail-closed verdict as scoring zero criteria", () => {
    // failClosedVerdict sets perCriterion: [] and missing: [reason]. A roster
    // that showed "1 gap" here would be repeating the bug the verdict card was
    // just fixed for.
    const roster = describePhaseRoster([
      row({
        verdict: verdict({
          perCriterion: [],
          missing: ["the judge call failed"],
        }),
      }),
    ]);
    const gate = roster[0].gate;
    expect(gate.assessed).toBe(true);
    if (gate.assessed) {
      expect(gate.criteriaAssessed).toBe(0);
      expect(gate.verdictReadable).toBe(true);
    }
  });

  it("keeps the decision when the stored verdict no longer parses", () => {
    // decision and reason are NOT NULL columns, so an unreadable blob still
    // has a real refusal behind it. Reporting it as unassessed would lose that;
    // reporting an empty gap list without saying why would read as "nothing was
    // wrong".
    const roster = describePhaseRoster([row({ verdict: { nonsense: true } })]);
    const gate = roster[0].gate;
    expect(gate.assessed).toBe(true);
    if (gate.assessed) {
      expect(gate.decision).toBe("BLOCK");
      expect(gate.verdictReadable).toBe(false);
      expect(gate.missing).toEqual([]);
    }
  });

  it("puts a completed arc's current marker on the last phase, not the first", () => {
    const roster = describePhaseRoster(
      ORDERED.map((phase) =>
        row({ phaseKey: phase.key, status: "passed", decision: "PASS" })
      )
    );
    expect(roster.every((entry) => entry.position === "passed")).toBe(true);
  });
});
