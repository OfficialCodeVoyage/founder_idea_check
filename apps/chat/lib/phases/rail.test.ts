import { describe, expect, it } from "vitest";
import {
  advanceRailWait,
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
