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

describe("describeAttemptSeries — a gate that failed closed is not progress", () => {
  const failClosed = {
    decision: "BLOCK",
    // Exactly what failClosedVerdict produces: a decision, a reason, and no
    // criteria scored at all.
    perCriterion: [],
    missing: ["the phase pass could not complete"],
    nextQuestion: "Restate where you have got to.",
    reason: "Gate failed closed: the phase pass could not complete.",
  };

  it("does NOT report criteria as closed when the gate simply did not run", () => {
    // Observed live: a stale dev server made the pass throw, and the next
    // attempt's diff announced that the founder had closed five criteria they
    // never touched. An empty perCriterion is absence, not a clean sheet.
    const steps = describeAttemptSeries([
      row({ attemptNo: 1, verdict: verdict(["a", "b", "c"]) }),
      row({ attemptNo: 2, verdict: failClosed }),
    ]);
    expect(steps[1].closed).toEqual([]);
    expect(steps[1].opened).toEqual([]);
    expect(steps[1].stillOpen).toEqual([]);
  });

  it("does not report criteria as NEWLY unmet on the attempt after one", () => {
    const steps = describeAttemptSeries([
      row({ attemptNo: 1, verdict: failClosed }),
      row({ attemptNo: 2, verdict: verdict(["a", "b"]) }),
    ]);
    expect(steps[1].opened).toEqual([]);
    expect(steps[1].stillOpen).toEqual([]);
  });

  it("still marks the fail-closed attempt readable, with its real reason", () => {
    // It is not a parse failure. The decision and the reason are genuine and a
    // founder should read them — it just carries no criterion state.
    const [step] = describeAttemptSeries([row({ verdict: failClosed })]);
    expect(step.detail.readable).toBe(true);
    if (step.detail.readable) {
      expect(step.detail.failedClosed).toBe(true);
      expect(step.detail.unmet).toBeNull();
    }
  });

  /**
   * The ledger is what a founder reads to see what they actually fixed. Folding
   * three different not-met states into one bucket is what let a card headline
   * "WHAT IS MISSING" sit over the words "could not be assessed".
   */
  it("keeps unmet, partial and not-evaluable in separate buckets", () => {
    const mixed = {
      decision: "BLOCK",
      perCriterion: [
        { criterionId: "kept", status: "met", evidence: "yes" },
        { criterionId: "absent", status: "unmet", gap: "nothing here" },
        { criterionId: "thin", status: "partial", gap: "asserted, not shown" },
        {
          criterionId: "unclear",
          status: "not-evaluable",
          gap: "the transcript does not say",
        },
      ],
      missing: [
        "nothing here",
        "asserted, not shown",
        "the transcript does not say",
      ],
      nextQuestion: "What next?",
      reason: "a reason",
    };

    const [step] = describeAttemptSeries([row({ verdict: mixed })]);
    expect(step.detail.readable).toBe(true);
    if (!step.detail.readable) {
      return;
    }
    expect(step.detail.outright).toEqual(["absent"]);
    expect(step.detail.partial).toEqual(["thin"]);
    expect(step.detail.notEvaluable).toEqual(["unclear"]);
    // The DIFF basis is unchanged: open-versus-closed is still the right
    // question for a diff, and all three are open.
    expect(step.detail.unmet).toEqual(["absent", "thin", "unclear"]);
  });

  it("reports all three as absent, not empty, when nothing was scored", () => {
    // Same trap as `unmet`: an empty list here would read as "none of these",
    // which is a claim about criteria that were never looked at.
    const [step] = describeAttemptSeries([
      row({
        verdict: {
          decision: "BLOCK",
          perCriterion: [],
          missing: ["the judge call failed"],
          nextQuestion: null,
          reason: "Gate failed closed",
        },
      }),
    ]);
    expect(step.detail.readable).toBe(true);
    if (!step.detail.readable) {
      return;
    }
    expect(step.detail.outright).toBeNull();
    expect(step.detail.partial).toBeNull();
    expect(step.detail.notEvaluable).toBeNull();
  });

  it("resumes diffing across the gap once two real verdicts sit together", () => {
    const steps = describeAttemptSeries([
      row({ attemptNo: 1, verdict: verdict(["a", "b"]) }),
      row({ attemptNo: 2, verdict: failClosed }),
      row({ attemptNo: 3, verdict: verdict(["a", "b"]) }),
      row({ attemptNo: 4, verdict: verdict(["b"], ["a"]) }),
    ]);
    expect(steps[2].closed).toEqual([]);
    expect(steps[3].closed).toEqual(["a"]);
    expect(steps[3].stillOpen).toEqual(["b"]);
  });
});
