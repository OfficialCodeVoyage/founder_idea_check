import { describe, expect, it } from "vitest";
import { type AttemptRow, describeAttemptSeries } from "./attempt-history";

function verdict(unmet: string[], met: string[] = []) {
  return {
    decision: unmet.length > 0 ? "BLOCK" : "PASS",
    perCriterion: [
      ...met.map((id) => ({
        criterionId: id,
        status: "met",
        evidence: "the founder said so",
      })),
      ...unmet.map((id) => ({
        criterionId: id,
        status: "unmet",
        gap: `${id} is not evidenced`,
      })),
    ],
    missing: unmet.map((id) => `${id} is not evidenced`),
    nextQuestion: "What next?",
    reason: "a reason",
  };
}

function row(over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    attemptNo: 1,
    decision: "BLOCK",
    reason: "1 blocking criterion is unmet.",
    nextQuestion: "Who told you this?",
    evaluatedAt: new Date("2026-08-21T12:00:00Z"),
    verdict: verdict(["who-has-it"]),
    ...over,
  };
}

describe("describeAttemptSeries — refusals as a record of learning", () => {
  it("returns nothing for a phase that was never judged", () => {
    expect(describeAttemptSeries([])).toEqual([]);
  });

  it("gives the FIRST attempt an empty diff, not a diff against nothing", () => {
    // Reporting every unmet criterion as "newly unmet" on the first run would
    // tell a founder they had just broken eight things on turn one.
    const [first] = describeAttemptSeries([
      row({ verdict: verdict(["a", "b", "c"]) }),
    ]);
    expect(first.closed).toEqual([]);
    expect(first.opened).toEqual([]);
    expect(first.stillOpen).toEqual([]);
  });

  it("names what the founder CLOSED between attempts", () => {
    // This is the whole feature: not "you were refused three times" but "you
    // closed evidence-of-pain on attempt 2 and willingness-to-pay is still
    // open".
    const steps = describeAttemptSeries([
      row({ attemptNo: 1, verdict: verdict(["evidence-of-pain", "wtp"]) }),
      row({ attemptNo: 2, verdict: verdict(["wtp"], ["evidence-of-pain"]) }),
    ]);
    expect(steps[1].closed).toEqual(["evidence-of-pain"]);
    expect(steps[1].stillOpen).toEqual(["wtp"]);
    expect(steps[1].opened).toEqual([]);
  });

  it("names a REGRESSION — a criterion that was met and is not any more", () => {
    const steps = describeAttemptSeries([
      row({ attemptNo: 1, verdict: verdict(["wtp"], ["who-has-it"]) }),
      row({ attemptNo: 2, verdict: verdict(["wtp", "who-has-it"]) }),
    ]);
    expect(steps[1].opened).toEqual(["who-has-it"]);
    expect(steps[1].stillOpen).toEqual(["wtp"]);
  });

  it("treats anything not positively met as unmet", () => {
    // "partial" and "not-evaluable" are not passes. The gate fails closed on
    // them and so must the history, or a founder reads a partial as done.
    const steps = describeAttemptSeries([
      row({
        verdict: {
          ...verdict([]),
          perCriterion: [
            { criterionId: "a", status: "partial", gap: "half" },
            { criterionId: "b", status: "not-evaluable", gap: "unclear" },
            { criterionId: "c", status: "met", evidence: "yes" },
          ],
        },
      }),
      row({ attemptNo: 2, verdict: verdict([], ["a", "b", "c"]) }),
    ]);
    expect([...steps[1].closed].sort()).toEqual(["a", "b"]);
  });

  it("keeps a real refusal readable when its stored verdict is not", () => {
    // decision and reason are NOT NULL columns. An unparseable blob still has a
    // real refusal behind it, and rendering "no criteria were unmet" would turn
    // a storage problem into good news.
    const [step] = describeAttemptSeries([row({ verdict: { junk: true } })]);
    expect(step.decision).toBe("BLOCK");
    expect(step.reason).toBe("1 blocking criterion is unmet.");
    expect(step.detail.readable).toBe(false);
    if (!step.detail.readable) {
      expect(step.detail.why).toContain("cannot be shown");
    }
  });

  it("does not diff ACROSS an unreadable attempt", () => {
    // A diff needs both sides. Comparing attempt 3 against attempt 1 because 2
    // could not be read would attribute the change to the wrong attempt.
    const steps = describeAttemptSeries([
      row({ attemptNo: 1, verdict: verdict(["a"]) }),
      row({ attemptNo: 2, verdict: { junk: true } }),
      row({ attemptNo: 3, verdict: verdict([], ["a"]) }),
    ]);
    expect(steps[1].closed).toEqual([]);
    expect(steps[2].closed).toEqual([]);
    expect(steps[2].stillOpen).toEqual([]);
  });

  it("preserves the order the query returned", () => {
    const steps = describeAttemptSeries([
      row({ attemptNo: 1 }),
      row({ attemptNo: 2 }),
      row({ attemptNo: 3 }),
    ]);
    expect(steps.map((s) => s.attemptNo)).toEqual([1, 2, 3]);
  });
});
