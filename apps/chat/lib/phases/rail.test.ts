import { assert, describe, expect, it } from "vitest";
import { PHASES } from "./definitions";
import {
  type AttemptLedgerStep,
  advanceRailWait,
  type ChecklistCriterion,
  describeAttemptStanding,
  describeCriterionChecklist,
  describeGateVerdict,
  describeRail,
  type RailStatus,
  type RailWait,
} from "./rail";
import type { GateObstacle } from "./types";

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

/**
 * THE HEADLINE USED TO BE A CONSTANT.
 *
 * Live, on attempts 2, 3, 4 and 7 of the problem-validation deadlock, the card
 * read "WHAT IS MISSING" over text that said "could not be assessed". Two
 * opposite situations under one heading, and the founder had no way to tell
 * which remedy applied.
 */
describe("describeGateVerdict — which state the founder is actually in", () => {
  it("heads a fieldwork block with what cannot be known, not what is missing", () => {
    const view = verdict({
      decision: "BLOCK",
      missing: ["willingness to pay has no evidence behind it"],
      criteriaAssessed: 8,
      obstacle: {
        kind: "fieldwork-required",
        criterionIds: ["willingness-to-pay"],
      },
    });

    expect(view.assessed).toBe(true);
    if (!view.assessed) {
      return;
    }
    expect(view.obstacle?.kind).toBe("fieldwork-required");
    expect(view.obstacle?.heading).toBe("What cannot be known yet");
    expect(view.obstacle?.heading).not.toContain("missing");
    // And the note has to tell them NOT to answer it — the opposite of the
    // instruction every other arm carries.
    expect(view.obstacle?.note).toContain("instrument");
    expect(view.obstacle?.note).toContain("threshold");
  });

  it("does not call a not-evaluable criterion missing", () => {
    const view = verdict({
      decision: "BLOCK",
      missing: ["the transcript does not say either way"],
      criteriaAssessed: 8,
      obstacle: { kind: "not-evaluable", criterionIds: ["evidence-quality"] },
    });

    expect(view.assessed).toBe(true);
    if (!view.assessed) {
      return;
    }
    expect(view.obstacle?.heading).toBe("What could not be assessed");
    expect(view.obstacle?.note).toContain("NOT the same");
  });

  it("still says 'missing' when something really is just missing", () => {
    const view = verdict({
      decision: "BLOCK",
      missing: ["no buyer is named"],
      criteriaAssessed: 8,
      obstacle: { kind: "evidence-missing", criterionIds: ["target-user"] },
    });

    expect(view.assessed).toBe(true);
    if (!view.assessed) {
      return;
    }
    expect(view.obstacle?.heading).toBe("What is missing");
  });

  it("leaves an older verdict with no arm alone", () => {
    // Every verdict in ProjectPhaseAttempt predates this field. They must keep
    // rendering under the heading they were written under, not acquire a reason
    // the gate never gave.
    const view = verdict({
      decision: "BLOCK",
      missing: ["no buyer is named"],
      criteriaAssessed: 8,
    });

    expect(view.assessed).toBe(true);
    if (!view.assessed) {
      return;
    }
    expect(view.obstacle).toBeNull();
  });
});

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

  it("keys gaps by criterion id, so two gapless criteria do not collide", () => {
    const noGap =
      "the judge marked this criterion unsatisfied but named no specific gap";
    const byId = verdict({
      decision: "BLOCK",
      missing: [noGap, noGap],
      obstacle: {
        kind: "evidence-missing",
        criterionIds: ["target-user", "problem-statement"],
      },
    });
    const byIndex = verdict({ decision: "BLOCK", missing: [noGap, noGap] });
    assert(byId.assessed && byIndex.assessed);
    expect(byId.gapKeys).toEqual(["target-user", "problem-statement"]);
    expect(new Set(byIndex.gapKeys).size).toBe(2);
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
    // lib/phases/gate.ts::failClosedVerdict returns perCriterion: [] and
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

/**
 * THE SEVEN STORED VERDICTS, IN THEIR REAL SHAPE.
 *
 * Read back out of ProjectPhaseAttempt for a QA project. `decideGate`
 * writes "<summary>: <every gap joined by '; '>." — so the card printed the
 * gaps inside the reason AND again as a list.
 */
const LIVE_GAP =
  "four evidence-backed rubric scores to calculate the validation score.";
const LIVE_REASON = `1 of 8 exit criteria could not be assessed: ${LIVE_GAP}`;

describe("describeGateVerdict — the gap is said once", () => {
  it("splits the reason at the first gap and keeps both halves", () => {
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: [LIVE_GAP],
      reason: LIVE_REASON,
    });
    assert(view.assessed);
    expect(view.headline).toEqual({
      kind: "summary",
      text: "1 of 8 exit criteria could not be assessed",
    });
    // The gaps are NOT dropped, and `reason` still carries the gate's own
    // sentence whole — the split is a rendering decision, not a filter.
    expect(view.gaps).toEqual([LIVE_GAP]);
    expect(view.reason).toBe(LIVE_REASON);
  });

  it("splits a reason listing SIX gaps, which is now the normal shape", () => {
    // Since the gate began reporting the whole open set rather than only the
    // group that decided, the reason ends with every gap joined by "; ".
    const gaps = ["no buyer is named", "no workaround is described"];
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: gaps,
      reason: `1 of 8 exit criteria could not be assessed, and 5 more of the 8 are still open: ${gaps.join("; ")}.`,
    });
    assert(view.assessed);
    expect(view.headline).toEqual({
      kind: "summary",
      text: "1 of 8 exit criteria could not be assessed, and 5 more of the 8 are still open",
    });
    expect(view.gaps).toHaveLength(2);
  });

  it("splits a reason that was cut off inside the first gap", () => {
    // A reason past the projection's cap arrives cut off inside one of its gaps
    // (attempt 1's five joined gaps did, when the cap was 300 characters).
    // Matching the whole gap string would fail and the truncated run-on would
    // sit above the same gaps rendered properly.
    const gap = `${"a".repeat(60)} the rest of this gap never fits`;
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: [gap],
      reason: `5 of 8 exit criteria are unmet: ${gap.slice(0, 50)}`,
    });
    assert(view.assessed);
    expect(view.headline).toEqual({
      kind: "summary",
      text: "5 of 8 exit criteria are unmet",
    });
  });

  it("prints the reason INSTEAD of the list when it is only the gap", () => {
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: [LIVE_GAP],
      reason: LIVE_GAP,
    });
    assert(view.assessed);
    expect(view.headline.kind).toBe("instead-of-list");
  });

  it("KEEPS a genuine single gap the reason never quotes", () => {
    // The failure mode of suppressing on `missing.length === 1`: one named gap
    // is the ordinary shape of a refusal, and deleting it would hide the only
    // thing the card exists to show.
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: ["No workaround has been named."],
      reason: "1 blocking criterion is unmet.",
    });
    assert(view.assessed);
    expect(view.headline).toEqual({
      kind: "summary",
      text: "1 blocking criterion is unmet.",
    });
  });

  it("has nothing to print above the list when the gate wrote no reason", () => {
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: ["no buyer is named"],
      reason: null,
    });
    assert(view.assessed);
    expect(view.headline).toEqual({ kind: "none" });
  });

  it("keeps a reason with no gaps beside it exactly as written", () => {
    const view = verdict({
      criteriaAssessed: 8,
      decision: "PASS",
      missing: [],
      reason: "Every blocking criterion is met.",
    });
    assert(view.assessed);
    expect(view.headline).toEqual({
      kind: "summary",
      text: "Every blocking criterion is met.",
    });
  });
});

/**
 * ONE HEADING MUST NOT SIT OVER TWO KINDS OF PROBLEM.
 *
 * `obstacle.kind` names the LEADING condition — the rule that fired first. Since
 * the gate began reporting the whole open blocking set, a verdict whose kind is
 * `not-evaluable` can carry six criteria of which five are plainly unmet, and
 * "What could not be assessed" is then wrong for five of the six.
 */
describe("describeGateVerdict — a mixed set gets a mixed heading", () => {
  const MIXED: GateObstacle = {
    kind: "not-evaluable",
    criterionIds: ["validation-score", "target-user", "existing-workarounds"],
  };

  it("does not claim a mixed set could not be assessed", () => {
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: ["a", "b", "c"],
      obstacle: MIXED,
      perCriterion: [
        { criterionId: "validation-score", status: "not-evaluable" },
        { criterionId: "target-user", status: "unmet" },
        { criterionId: "existing-workarounds", status: "partial" },
      ],
    });
    assert(view.assessed);
    expect(view.obstacle?.kind).toBe("mixed");
    expect(view.obstacle?.heading).toBe("What is still open");
    expect(view.obstacle?.note).toContain("not all the same kind");
  });

  it("keeps the arm's own heading when the whole set really is one kind", () => {
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: ["a", "b"],
      obstacle: {
        kind: "not-evaluable",
        criterionIds: ["validation-score", "evidence-quality"],
      },
      perCriterion: [
        { criterionId: "validation-score", status: "not-evaluable" },
        { criterionId: "evidence-quality", status: "not-evaluable" },
      ],
    });
    assert(view.assessed);
    expect(view.obstacle?.kind).toBe("not-evaluable");
  });

  it("does not call unmet-plus-partial mixed — both close the same way", () => {
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: ["a", "b"],
      obstacle: {
        kind: "evidence-missing",
        criterionIds: ["target-user", "existing-workarounds"],
      },
      perCriterion: [
        { criterionId: "target-user", status: "unmet" },
        { criterionId: "existing-workarounds", status: "partial" },
      ],
    });
    assert(view.assessed);
    expect(view.obstacle?.kind).toBe("evidence-missing");
  });

  it("leaves the heading alone when the caller tracks no per-criterion state", () => {
    // Absence is "this caller does not know", never "the set is uniform".
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: ["a", "b"],
      obstacle: MIXED,
    });
    assert(view.assessed);
    expect(view.obstacle?.kind).toBe("not-evaluable");
  });

  it("ignores criterion ids it has no evaluation for", () => {
    // Guessing a status for an id the judge never scored would be the same
    // mistake one level down.
    const view = verdict({
      criteriaAssessed: 8,
      decision: "BLOCK",
      missing: ["a"],
      obstacle: MIXED,
      perCriterion: [
        { criterionId: "validation-score", status: "not-evaluable" },
      ],
    });
    assert(view.assessed);
    expect(view.obstacle?.kind).toBe("not-evaluable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Where the founder stands: which attempt this is, what moved, what repeats.
// ─────────────────────────────────────────────────────────────────────────────

function step(over: Partial<AttemptLedgerStep> = {}): AttemptLedgerStep {
  return {
    attemptNo: 1,
    decision: "BLOCK",
    unmet: [],
    closed: [],
    opened: [],
    stillOpen: [],
    ...over,
  };
}

/**
 * describeAttemptStanding with every criterion the ledger names defined as
 * blocking, unless the case passes its own definitions.
 */
function standing(input: {
  attemptCount: number;
  ledger: AttemptLedgerStep[];
  criteria?: { id: string; severity: "blocking" | "advisory" }[];
}) {
  const ids = new Set(input.ledger.flatMap((s) => s.unmet ?? []));
  return describeAttemptStanding({
    ...input,
    criteria:
      input.criteria ??
      [...ids].map((id) => ({ id, severity: "blocking" as const })),
  });
}

describe("describeAttemptStanding — 'attempt 7' and 'this is the fourth time'", () => {
  it("never counts an advisory criterion as having blocked anything", () => {
    // An advisory miss can only downgrade to WARN. "people-interviewed has
    // blocked 2 of 2 attempts", beside its own "advisory only" tag, called it
    // the opposite of what it is.
    const s = standing({
      attemptCount: 2,
      ledger: [
        step({ attemptNo: 1, unmet: ["people-interviewed", "target-user"] }),
        step({ attemptNo: 2, unmet: ["people-interviewed", "target-user"] }),
      ],
      criteria: [
        { id: "people-interviewed", severity: "advisory" },
        { id: "target-user", severity: "blocking" },
      ],
    });
    expect(s.repeats).toEqual([
      { criterionId: "target-user", blocked: 2, of: 2 },
    ]);
  });

  it("does not count a WARN attempt as one a criterion blocked", () => {
    // The gate let attempt 2 through with the criterion open, so it blocked
    // one attempt of the three, and the WARN still counts in the denominator.
    const s = standing({
      attemptCount: 3,
      ledger: [
        step({ attemptNo: 1, unmet: ["validation-score"] }),
        step({ attemptNo: 2, decision: "WARN", unmet: ["validation-score"] }),
        step({ attemptNo: 3, unmet: ["validation-score"] }),
      ],
    });
    expect(s.repeats).toEqual([
      { criterionId: "validation-score", blocked: 2, of: 3 },
    ]);
  });

  it("reports no repeat when the latest attempt was not a BLOCK", () => {
    const s = standing({
      attemptCount: 2,
      ledger: [
        step({ attemptNo: 1, unmet: ["validation-score"] }),
        step({ attemptNo: 2, decision: "WARN", unmet: ["validation-score"] }),
      ],
    });
    expect(s.repeats).toEqual([]);
  });

  it("names the attempt the founder is on", () => {
    // Seven refusals rendered identically and standalone. Nothing on any of
    // them said which one it was, which is why the seventh read as pushback
    // rather than as position in a sequence.
    const s = standing({ attemptCount: 7, ledger: [] });
    expect(s.attemptLabel).toBe("Attempt 7");
  });

  it("names no attempt at all before the gate has ever run", () => {
    // "Attempt 0" is a number standing in for "never judged".
    expect(standing({ attemptCount: 0, ledger: [] }).attemptLabel).toBeNull();
  });

  it("counts how many attempts one criterion has blocked", () => {
    const s = standing({
      attemptCount: 3,
      ledger: [
        step({ attemptNo: 1, unmet: ["validation-score", "target-user"] }),
        step({ attemptNo: 2, unmet: ["validation-score"] }),
        step({ attemptNo: 3, unmet: ["validation-score"] }),
      ],
    });
    expect(s.repeats).toEqual([
      { criterionId: "validation-score", blocked: 3, of: 3 },
    ]);
  });

  it("reports nothing as repeating on its first refusal", () => {
    const s = standing({
      attemptCount: 1,
      ledger: [step({ attemptNo: 1, unmet: ["validation-score"] })],
    });
    expect(s.repeats).toEqual([]);
  });

  it("reports only criteria that are STILL open, not ones already closed", () => {
    // "target-user has blocked 2 of your 3 attempts" is a true sentence and a
    // useless one once the founder has closed it. The repeat line is about what
    // is in the way now.
    const s = standing({
      attemptCount: 3,
      ledger: [
        step({ attemptNo: 1, unmet: ["target-user", "validation-score"] }),
        step({ attemptNo: 2, unmet: ["target-user", "validation-score"] }),
        step({ attemptNo: 3, unmet: ["validation-score"] }),
      ],
    });
    expect(s.repeats.map((r) => r.criterionId)).toEqual(["validation-score"]);
  });

  it("counts only attempts that had criterion state, and says so in `of`", () => {
    // An attempt where the gate failed closed scored nothing. Counting it as an
    // attempt this criterion did NOT block would understate the repeat — the
    // gate never looked.
    const s = standing({
      attemptCount: 3,
      ledger: [
        step({ attemptNo: 1, unmet: ["validation-score"] }),
        step({ attemptNo: 2, unmet: null }),
        step({ attemptNo: 3, unmet: ["validation-score"] }),
      ],
    });
    expect(s.repeats).toEqual([
      { criterionId: "validation-score", blocked: 2, of: 2 },
    ]);
  });

  it("claims no repeat at all when the LATEST attempt scored nothing", () => {
    // The card is showing that attempt. Saying "this criterion is still
    // blocking you" over a verdict that judged nothing is a claim about work
    // the gate never looked at.
    const s = standing({
      attemptCount: 3,
      ledger: [
        step({ attemptNo: 1, unmet: ["validation-score"] }),
        step({ attemptNo: 2, unmet: ["validation-score"] }),
        step({ attemptNo: 3, unmet: null }),
      ],
    });
    expect(s.repeats).toEqual([]);
  });

  it("says a single repeat as one plain sentence", () => {
    const s = standing({
      attemptCount: 2,
      ledger: [
        step({ attemptNo: 1, unmet: ["validation-score"] }),
        step({ attemptNo: 2, unmet: ["validation-score"] }),
      ],
    });
    expect(s.repeatNote).toBe(
      "validation-score has blocked 2 of the 2 attempts on record."
    );
  });

  it("does not print seven identical lines when seven criteria repeat", () => {
    // Replayed against the seven real attempts, six criteria had blocked all
    // seven. As seven lines that is a wall of identical text sitting on top of
    // the regression — the one line the founder could not have worked out for
    // themselves. Every repeat still reaches the checklist.
    const ids = ["a-one", "b-two", "c-three"];
    const s = standing({
      attemptCount: 2,
      ledger: [
        step({ attemptNo: 1, unmet: ids }),
        step({ attemptNo: 2, unmet: ids }),
      ],
    });
    expect(s.repeats).toHaveLength(3);
    expect(s.repeatNote).toContain("3 of the criteria still open");
    expect(s.repeatNote).toContain("checklist below");
  });

  it("says nothing at all when nothing repeats", () => {
    expect(standing({ attemptCount: 1, ledger: [] }).repeatNote).toBeNull();
  });

  it("puts the criterion that has blocked most often first", () => {
    const s = standing({
      attemptCount: 3,
      ledger: [
        step({ attemptNo: 1, unmet: ["a-criterion", "b-criterion"] }),
        step({ attemptNo: 2, unmet: ["b-criterion"] }),
        step({ attemptNo: 3, unmet: ["a-criterion", "b-criterion"] }),
      ],
    });
    expect(s.repeats.map((r) => r.criterionId)).toEqual([
      "b-criterion",
      "a-criterion",
    ]);
  });

  it("counts a duplicated id in one verdict once", () => {
    // The judge writes the list; a duplicate there is its own defect and must
    // not inflate the repeat count, nor produce two rows with one key.
    const s = standing({
      attemptCount: 2,
      ledger: [
        step({ attemptNo: 1, unmet: ["validation-score", "validation-score"] }),
        step({ attemptNo: 2, unmet: ["validation-score"] }),
      ],
    });
    expect(s.repeats).toEqual([
      { criterionId: "validation-score", blocked: 2, of: 2 },
    ]);
  });
});

describe("describeAttemptStanding — the diff, regressions included", () => {
  it("carries the latest attempt's diff through", () => {
    // 5 -> 1 -> 1 -> 1 -> 5 -> 5 -> 1. The founder closed four criteria,
    // watched them re-open twice, and was told none of it.
    const s = standing({
      attemptCount: 5,
      ledger: [
        step({ attemptNo: 4, unmet: ["validation-score"] }),
        step({
          attemptNo: 5,
          unmet: ["validation-score", "target-user"],
          opened: ["target-user"],
          stillOpen: ["validation-score"],
        }),
      ],
    });
    expect(s.progress).toEqual({
      closed: [],
      opened: ["target-user"],
      stillOpen: ["validation-score"],
    });
  });

  it("claims nothing when there is no diff to report", () => {
    // describeAttemptSeries writes three empty lists both when nothing changed
    // and when the two attempts could not be compared at all. An empty object
    // rendered as "nothing moved" would be a claim in the second case, so the
    // arm is null and the card says nothing.
    expect(standing({ attemptCount: 1, ledger: [step()] }).progress).toBeNull();
    expect(standing({ attemptCount: 0, ledger: [] }).progress).toBeNull();
  });

  it("reports a regression even when nothing else moved", () => {
    const s = standing({
      attemptCount: 2,
      ledger: [step({ attemptNo: 1 }), step({ attemptNo: 2, opened: ["x-y"] })],
    });
    expect(s.progress?.opened).toEqual(["x-y"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// All eight criteria, with their state, without leaving the conversation.
// ─────────────────────────────────────────────────────────────────────────────

function criterion(
  id: string,
  over: Partial<ChecklistCriterion> = {}
): ChecklistCriterion {
  return {
    id,
    description: `what ${id} requires`,
    severity: "blocking",
    closure: "in-conversation",
    ...over,
  };
}

const EIGHT = PHASES[0].exitCriteria.map((c) => ({
  id: c.id,
  description: c.description,
  severity: c.severity,
  closure: c.closure,
}));

describe("describeCriterionChecklist — a verdict that never ran has no rows", () => {
  it("shows NO rows when the gate scored nothing", () => {
    // failClosedVerdict returns perCriterion: []. Eight grey "untouched" rows
    // would tell a founder the gate looked at all eight and found nothing —
    // when it never ran. Six bugs in this codebase were this exact shape.
    const list = describeCriterionChecklist({
      criteria: EIGHT,
      perCriterion: [],
      verdictReadable: true,
      obstacle: null,
    });
    expect(list.available).toBe(false);
    assert(!list.available);
    expect("rows" in list).toBe(false);
    expect(list.note).toContain("no criterion was scored");
  });

  it("shows NO rows when the stored verdict cannot be read", () => {
    const list = describeCriterionChecklist({
      criteria: EIGHT,
      perCriterion: [],
      verdictReadable: false,
      obstacle: null,
    });
    assert(!list.available);
    expect(list.note).toContain("no longer be read");
    // And it must not be the same sentence as the never-ran one: one is a
    // storage failure, the other is the gate failing closed.
    expect(list.note).not.toContain("no criterion was scored");
  });

  it("shows no rows for a phase that defines no criteria", () => {
    const list = describeCriterionChecklist({
      criteria: [],
      perCriterion: [{ criterionId: "x-y", status: "met" }],
      verdictReadable: true,
      obstacle: null,
    });
    assert(!list.available);
    expect(list.note).toContain("exit criteria");
  });
});

describe("describeCriterionChecklist — the eight rows", () => {
  const scored = describeCriterionChecklist({
    criteria: [
      criterion("problem-statement"),
      criterion("target-user"),
      criterion("existing-workarounds", { closure: "offline-only" }),
      criterion("validation-score", { closure: "offline-only" }),
      criterion("people-interviewed", {
        closure: "offline-only",
        severity: "advisory",
      }),
    ],
    perCriterion: [
      { criterionId: "problem-statement", status: "met" },
      { criterionId: "target-user", status: "met" },
      { criterionId: "existing-workarounds", status: "partial" },
      { criterionId: "validation-score", status: "not-evaluable" },
    ],
    verdictReadable: true,
    obstacle: null,
  });

  it("keeps one row per DEFINED criterion, in definition order", () => {
    assert(scored.available);
    expect(scored.rows.map((r) => r.id)).toEqual([
      "problem-statement",
      "target-user",
      "existing-workarounds",
      "validation-score",
      "people-interviewed",
    ]);
  });

  it("does not report a criterion the judge skipped as met OR as unmet", () => {
    // The judge returned four evaluations for five criteria. "not met" is a
    // finding; "the judge did not score this" is not, and folding the second
    // into the first invents a refusal the gate never wrote.
    assert(scored.available);
    const skipped = scored.rows.find((r) => r.id === "people-interviewed");
    expect(skipped?.state).toBe("unscored");
    expect(skipped?.label).not.toContain("not met");
  });

  it("gives each of the five states its own label", () => {
    assert(scored.available);
    const labels = new Set(scored.rows.map((r) => r.label));
    expect(labels.size).toBe(4);
    expect(scored.rows[0].label).toBe("met");
    expect(scored.rows[3].label).toContain("could not be assessed");
  });

  it("says which open criteria need fieldwork rather than an answer", () => {
    // The whole point of `closure`: "you have not said this" and "nobody could
    // say this yet" are different rows with opposite remedies.
    assert(scored.available);
    expect(scored.summary).toContain("outside this conversation");
    expect(scored.metCount).toBe(2);
    expect(scored.openCount).toBe(3);
  });

  it("attaches the repeat count to the criterion it is about", () => {
    const list = describeCriterionChecklist({
      criteria: [criterion("validation-score"), criterion("target-user")],
      perCriterion: [
        { criterionId: "validation-score", status: "unmet" },
        { criterionId: "target-user", status: "met" },
      ],
      repeats: [{ criterionId: "validation-score", blocked: 4, of: 7 }],
      verdictReadable: true,
      obstacle: null,
    });
    assert(list.available);
    expect(list.rows[0].repeat).toEqual({
      criterionId: "validation-score",
      blocked: 4,
      of: 7,
    });
    expect(list.rows[1].repeat).toBeNull();
  });

  it("counts an all-met phase honestly", () => {
    const list = describeCriterionChecklist({
      criteria: [criterion("a-one"), criterion("b-two")],
      perCriterion: [
        { criterionId: "a-one", status: "met" },
        { criterionId: "b-two", status: "met" },
      ],
      verdictReadable: true,
      obstacle: null,
    });
    assert(list.available);
    expect(list.metCount).toBe(2);
    expect(list.openCount).toBe(0);
    expect(list.summary).toBe("2 of 2 met.");
  });
});
