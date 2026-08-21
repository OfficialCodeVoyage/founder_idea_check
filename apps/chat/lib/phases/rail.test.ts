import { assert, describe, expect, it } from "vitest";
import {
  advanceRailWait,
  describeGateVerdict,
  describeRail,
  type RailStatus,
  type RailWait,
} from "./rail";

const TOTAL = 8;

function rail(over: Partial<Parameters<typeof describeRail>[0]> = {}) {
  return describeRail({
    decision: null,
    missing: [],
    workflowComplete: false,
    total: TOTAL,
    assessment: "idle",
    ...over,
  });
}

describe("describeRail — the five states stay apart", () => {
  it("does NOT report a pass as 'no assessment yet'", () => {
    // The reported defect: decideGate returns missing: [] on both PASS paths,
    // so the old `missing.at(0) ?? "no assessment yet"` fired on a pass while
    // the badge beside it said READY.
    const r = rail({ decision: "PASS", missing: [] });

    expect(r.status).toBe("passed");
    expect(r.label).toBe("READY");
    expect(r.detail).not.toContain("no assessment yet");
    expect(r.detail).toBe("this phase passed its gate");
  });

  it("reports a finished arc as COMPLETE, naming the phase count", () => {
    const r = rail({ decision: "PASS", workflowComplete: true, missing: [] });

    expect(r.status).toBe("complete");
    expect(r.label).toBe("COMPLETE");
    expect(r.detail).toBe("all 8 phases passed their gate");
  });

  it("keeps 'never assessed' distinct from 'blocked'", () => {
    // Collapsing these is the one thing this project refuses to do: on turn 1
    // the prompt is telling the founder to describe the problem, and a red
    // BLOCKED badge beside it teaches them the badge means nothing.
    const unassessed = rail({ decision: null });
    const blocked = rail({ decision: "BLOCK", missing: ["no named user"] });

    expect(unassessed.status).toBe("unassessed");
    expect(unassessed.label).toBe("NOT ASSESSED");
    expect(blocked.status).toBe("blocked");
    expect(blocked.label).toBe("BLOCKED");
    expect(unassessed.detail).not.toBe(blocked.detail);
  });

  it("gives a BLOCK with no named gap its own sentence, not the pass one", () => {
    const r = rail({ decision: "BLOCK", missing: [] });

    expect(r.status).toBe("blocked");
    expect(r.detail).toBe(
      "the gate refused this phase but named no specific gap"
    );
  });

  it("gives a WARN with no named gap its own sentence", () => {
    const r = rail({ decision: "WARN", missing: [] });

    expect(r.status).toBe("thin");
    expect(r.detail).toBe(
      "the gate flagged a weakness but named no specific gap"
    );
  });

  it("prefers the gate's own named gap over every fallback", () => {
    const r = rail({ decision: "BLOCK", missing: ["a third named user", "x"] });
    expect(r.detail).toBe("a third named user");
  });

  it("reports a WARN on the last phase as THIN, not COMPLETE", () => {
    // planPhaseAdvance advances on WARN, so workflowComplete is true here.
    // Reporting COMPLETE would hide the gate's reservations on the arc's very
    // last verdict.
    const r = rail({ decision: "WARN", workflowComplete: true, missing: [] });

    expect(r.status).toBe("thin");
    expect(r.label).toBe("THIN");
  });

  it("reports a BLOCK on a finished arc as BLOCKED, matching the prompt", () => {
    const r = rail({ decision: "BLOCK", workflowComplete: true, missing: [] });
    expect(r.status).toBe("blocked");
  });

  it("gives all five statuses a distinct label and detail", () => {
    const seen = new Map<RailStatus, { label: string; detail: string }>();
    for (const r of [
      rail({ decision: null }),
      rail({ decision: "BLOCK" }),
      rail({ decision: "WARN" }),
      rail({ decision: "PASS" }),
      rail({ decision: "PASS", workflowComplete: true }),
    ]) {
      seen.set(r.status, { label: r.label, detail: r.detail });
    }

    expect(seen.size).toBe(5);
    expect(new Set([...seen.values()].map((v) => v.label)).size).toBe(5);
    expect(new Set([...seen.values()].map((v) => v.detail)).size).toBe(5);
  });
});

describe("describeRail — pending marker", () => {
  it("is null when the rail is current", () => {
    expect(rail({ assessment: "idle" }).pending).toBeNull();
  });

  it("says the badge is the LAST verdict while waiting", () => {
    const p = rail({ assessment: "waiting" }).pending;
    expect(p).not.toBeNull();
    expect(p?.marker).toBe("checking…");
  });

  it("says the badge is an EARLIER turn's, and not a block, when unreported", () => {
    // The founder must not read a stale verdict as a judgement of what they
    // just said, nor as being blocked.
    const p = rail({ assessment: "unreported" }).pending;
    expect(p?.note).toContain("EARLIER turn");
    expect(p?.note).toContain("not the same as being blocked");
  });
});

describe("advanceRailWait", () => {
  const idle: RailWait = { kind: "idle" };

  it("starts waiting with no baseline when a turn starts", () => {
    expect(advanceRailWait(idle, { type: "turn-started" })).toEqual({
      kind: "waiting",
      baseline: null,
    });
  });

  it("records the baseline when the turn ends", () => {
    expect(
      advanceRailWait(
        { kind: "waiting", baseline: null },
        { type: "turn-ended", count: 4 }
      )
    ).toEqual({ kind: "waiting", baseline: 4 });
  });

  it("goes idle once the assessment count changes", () => {
    expect(
      advanceRailWait(
        { kind: "waiting", baseline: 4 },
        { type: "state-read", count: 5 }
      )
    ).toEqual({ kind: "idle" });
  });

  it("returns the IDENTICAL object when the count has not moved", () => {
    // Object identity, so React bails out instead of re-rendering forever.
    const wait: RailWait = { kind: "waiting", baseline: 4 };
    expect(advanceRailWait(wait, { type: "state-read", count: 4 })).toBe(wait);
  });

  it("carries the baseline through the ceiling", () => {
    expect(
      advanceRailWait(
        { kind: "waiting", baseline: 4 },
        { type: "ceiling-reached" }
      )
    ).toEqual({ kind: "unreported", baseline: 4 });
  });

  it("RECOVERS from unreported when a verdict finally lands", () => {
    // The bug this prevents: discarding the baseline at the ceiling meant a
    // wait that timed out on a blurred tab kept asserting "no verdict for this
    // turn" on top of a verdict that had since arrived.
    expect(
      advanceRailWait(
        { kind: "unreported", baseline: 4 },
        { type: "state-read", count: 5 }
      )
    ).toEqual({ kind: "idle" });
  });

  it("stays unreported, identically, while the count is unchanged", () => {
    const wait: RailWait = { kind: "unreported", baseline: 4 };
    expect(advanceRailWait(wait, { type: "state-read", count: 4 })).toBe(wait);
  });

  it("adopts a first reading rather than treating null as zero", () => {
    // `?? 0` here would make the very first verdict look like no verdict.
    expect(
      advanceRailWait(
        { kind: "waiting", baseline: null },
        { type: "state-read", count: 0 }
      )
    ).toEqual({ kind: "waiting", baseline: 0 });
  });

  it("ignores a state read while idle", () => {
    expect(advanceRailWait(idle, { type: "state-read", count: 9 })).toBe(idle);
  });

  it("does not move to unreported from idle", () => {
    expect(advanceRailWait(idle, { type: "ceiling-reached" })).toBe(idle);
  });
});

function verdict(
  over: Partial<Parameters<typeof describeGateVerdict>[0]> = {}
) {
  return describeGateVerdict({
    decision: null,
    missing: [],
    workflowComplete: false,
    total: TOTAL,
    assessment: "idle",
    ...over,
  });
}

describe("describeGateVerdict — the card shows the WHOLE refusal", () => {
  it("names every gap, not just the first", () => {
    // The rail shows `missing.at(0)` because it has 36px. That is why a founder
    // blocked on three criteria could see exactly one of them. This is the
    // whole point of the card.
    const view = verdict({
      decision: "BLOCK",
      missing: ["no permalink", "segment is not a buyer", "no price named"],
    });
    expect(view.assessed).toBe(true);
    assert(view.assessed);
    expect(view.gaps).toEqual([
      "no permalink",
      "segment is not a buyer",
      "no price named",
    ]);
  });

  it("does NOT report a verdict for a phase the gate has not assessed", () => {
    const view = verdict({ decision: null, missing: [] });
    expect(view.assessed).toBe(false);
    assert(!view.assessed);
    // No status and no label to read. Rendering "BLOCKED" for a phase nobody
    // judged is the inversion this whole feature exists to prevent, so it is a
    // compile error rather than a convention.
    expect("status" in view).toBe(false);
    expect("gaps" in view).toBe(false);
    expect(view.note).toContain("not assessed");
  });

  it("keeps 'refused and named no gap' apart from 'passed'", () => {
    // Both have an empty `missing`. An empty gap list alone cannot tell them
    // apart, which is why the note exists.
    const blocked = verdict({ decision: "BLOCK", missing: [] });
    const passed = verdict({ decision: "PASS", missing: [] });
    assert(blocked.assessed && passed.assessed);
    expect(blocked.gaps).toEqual([]);
    expect(passed.gaps).toEqual([]);
    expect(blocked.noGapNote).toContain("refused");
    expect(passed.noGapNote).toBeNull();
  });

  it("distinguishes a warned phase from a refused one", () => {
    const warned = verdict({ decision: "WARN", missing: [] });
    assert(warned.assessed);
    expect(warned.status).toBe("thin");
    expect(warned.noGapNote).toContain("weakness");
  });

  it("reports a completed arc as complete, not merely passed", () => {
    const done = verdict({ decision: "PASS", workflowComplete: true });
    assert(done.assessed);
    expect(done.status).toBe("complete");
  });

  it("does not report a WARN on the last phase as COMPLETE", () => {
    // planPhaseAdvance advances on WARN, so a WARN on phase 8 yields
    // workflowComplete: true. Calling that COMPLETE would hide, on the arc's
    // very last verdict, that the gate had reservations. Same rule as the rail.
    const warned = verdict({ decision: "WARN", workflowComplete: true });
    assert(warned.assessed);
    expect(warned.status).toBe("thin");
  });

  it("carries the gate's own sentences through untouched", () => {
    const view = verdict({
      decision: "BLOCK",
      reason: "No evidence anyone has this problem.",
      nextQuestion: "Where did you last see someone describe it?",
    });
    assert(view.assessed);
    expect(view.reason).toBe("No evidence anyone has this problem.");
    expect(view.nextQuestion).toBe(
      "Where did you last see someone describe it?"
    );
  });

  it("surfaces the pending marker on BOTH arms", () => {
    // A stale verdict must say so whether or not one exists yet, otherwise the
    // card silently presents an earlier turn's judgement as this turn's.
    const stale = verdict({ decision: "BLOCK", assessment: "unreported" });
    const none = verdict({ decision: null, assessment: "waiting" });
    expect(stale.pending?.marker).toBeTruthy();
    expect(none.pending?.marker).toBeTruthy();
  });

  it("agrees with the rail about the status, always", () => {
    // Two renderers of one fact. They disagreed once already — the rail said
    // "READY / no assessment yet" after all eight gates passed.
    for (const decision of ["PASS", "WARN", "BLOCK", null] as const) {
      for (const workflowComplete of [true, false]) {
        const r = rail({ decision, workflowComplete });
        const v = verdict({ decision, workflowComplete });
        if (v.assessed) {
          expect(v.status, `${decision}/${workflowComplete}`).toBe(r.status);
          expect(v.label).toBe(r.label);
        } else {
          expect(r.status).toBe("unassessed");
        }
      }
    }
  });
});

describe("describeGateVerdict — a fail-closed BLOCK is not a gap list", () => {
  it("does NOT present a fail-closed verdict as one missing thing", () => {
    // failClosedVerdict (gate.ts:298) returns perCriterion: [] and
    // missing: [reason]. Rendering that as "1 thing is missing" tells a founder
    // the gate found one gap, when the gate never ran and all 8 criteria are
    // still pending. This is the inversion the whole card exists to avoid,
    // arriving through the card itself.
    const view = verdict({
      criteriaAssessed: 0,
      decision: "BLOCK",
      missing: ["the judge call failed (503 upstream)"],
      verdictReadable: true,
    });
    assert(view.assessed);
    expect(view.coverage).toEqual({ kind: "none-scored" });
  });

  it("reports a real refusal as scored, with the criterion count", () => {
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: ["no permalink", "no price named"],
      verdictReadable: true,
    });
    assert(view.assessed);
    expect(view.coverage).toEqual({ kind: "scored", criteria: 8 });
  });

  it("keeps 'could not be read' apart from 'named no gap'", () => {
    // toPhaseGateState returns missing: [] when the blob fails to parse, while
    // still returning the decision — so without this flag an unreadable BLOCK
    // is indistinguishable from a BLOCK that named nothing.
    const unreadable = verdict({
      criteriaAssessed: 0,
      decision: "BLOCK",
      missing: [],
      verdictReadable: false,
    });
    const namedNothing = verdict({
      criteriaAssessed: 5,
      decision: "BLOCK",
      missing: [],
      verdictReadable: true,
    });
    assert(unreadable.assessed && namedNothing.assessed);
    expect(unreadable.coverage.kind).toBe("unreadable");
    expect(namedNothing.coverage).toEqual({ kind: "scored", criteria: 5 });
    expect(namedNothing.noGapNote).toContain("refused");
  });

  it("defaults toward not accusing a working gate of failing closed", () => {
    // A caller that tracks neither flag still gets `scored` for a verdict that
    // named gaps. The default must not invent a failure.
    const view = verdict({ decision: "BLOCK", missing: ["no permalink"] });
    assert(view.assessed);
    expect(view.coverage).toEqual({ kind: "scored", criteria: 1 });
  });
});
