import { describe, expect, it } from "vitest";
import type { StoredFact } from "@/lib/phases/context";
import { PHASES } from "@/lib/phases/definitions";
import { PHASE_COUNT } from "@/lib/phases/types";
import {
  allWorkflowFactKeys,
  buildDocumentContext,
  buildFactIndex,
  confidenceBand,
  decideExportReadiness,
  exportSections,
  FACT_LABELS,
  formatUtcDate,
  groundFact,
  HIGH_CONFIDENCE_FLOOR,
  LOW_CONFIDENCE_CEILING,
  LOW_CONFIDENCE_MARKER,
  labelFor,
  missingFromVerdict,
  phaseStateFor,
  phaseStatusLabel,
  renderGrounded,
} from "./grounding";
import type { ExportPhaseState } from "./types";

const AT = new Date("2026-03-01T12:00:00.000Z");

function fact(
  key: string,
  value: string,
  confidence = 90,
  phaseKey = "problem-validation",
  updatedAt = AT
): StoredFact {
  return { key, value, confidence, phaseKey, updatedAt };
}

function passed(phaseKey: string): ExportPhaseState {
  return {
    phaseKey,
    status: "passed",
    decision: "PASS",
    reason: "All exit criteria met: 8/8 passed.",
    nextQuestion: null,
    missing: [],
  };
}

describe("FACT_LABELS — the drift guard against a machine-shaped PRD", () => {
  it("has an explicit label for every fact key every phase can write", () => {
    // THE POINT OF THIS TEST: the day a phase definition gains a fact key, this
    // fails instead of the PRD silently rendering a heading called
    // "gtm channel cac". A generated document with a machine-shaped heading
    // tells the founder the generator does not know what it is talking about.
    const missing = allWorkflowFactKeys().filter((key) => !FACT_LABELS[key]);
    expect(missing).toEqual([]);
  });

  it("has no label for a key no phase defines", () => {
    // The other direction: a stale label is a section heading for a fact that
    // can never exist, which reads as a question the workflow forgot to ask.
    const known = new Set(allWorkflowFactKeys());
    const stale = Object.keys(FACT_LABELS).filter((key) => !known.has(key));
    expect(stale).toEqual([]);
  });

  it("falls back to a de-snaked label only for unknown keys", () => {
    expect(labelFor("problem_statement")).toBe("Problem statement");
    expect(labelFor("legacy_market_size")).toBe("Legacy market size");
  });
});

describe("exportSections — derived from PHASES, never transcribed", () => {
  it("covers all eight phases in order", () => {
    const sections = exportSections();
    expect(sections).toHaveLength(PHASE_COUNT);
    expect(sections.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sections.map((s) => s.phaseKey)).toEqual(PHASES.map((p) => p.key));
  });

  it("carries each phase's fact keys verbatim", () => {
    const first = exportSections()[0];
    expect(first.factKeys).toEqual(PHASES[0].factKeys);
  });
});

describe("confidenceBand — where doubt becomes visible", () => {
  it("bands at the documented boundaries", () => {
    expect(confidenceBand(0)).toBe("low");
    expect(confidenceBand(LOW_CONFIDENCE_CEILING - 1)).toBe("low");
    expect(confidenceBand(LOW_CONFIDENCE_CEILING)).toBe("medium");
    expect(confidenceBand(HIGH_CONFIDENCE_FLOOR - 1)).toBe("medium");
    expect(confidenceBand(HIGH_CONFIDENCE_FLOOR)).toBe("high");
    expect(confidenceBand(100)).toBe("high");
  });
});

describe("buildFactIndex — one winner per key, matching the gate's own rule", () => {
  it("keeps the highest confidence", () => {
    const index = buildFactIndex([
      fact("target_user", "everyone", 40),
      fact("target_user", "urban dog walkers", 95),
    ]);
    expect(index.get("target_user")?.value).toBe("urban dog walkers");
  });

  it("breaks a confidence tie with the most recent row", () => {
    const older = fact("target_user", "old", 70, "problem-validation", AT);
    const newer = fact(
      "target_user",
      "new",
      70,
      "problem-validation",
      new Date("2026-04-01T00:00:00.000Z")
    );
    expect(buildFactIndex([older, newer]).get("target_user")?.value).toBe(
      "new"
    );
    // Order of the input must not decide the winner.
    expect(buildFactIndex([newer, older]).get("target_user")?.value).toBe(
      "new"
    );
  });
});

describe("groundFact — the only way a project claim enters a document", () => {
  it("returns the stored value with its provenance", () => {
    const index = buildFactIndex([fact("target_user", "dog walkers", 88)]);
    expect(groundFact(index, "target_user")).toEqual({
      status: "established",
      key: "target_user",
      value: "dog walkers",
      confidence: 88,
      band: "high",
      // A fact with no `origin` is an extracted one, as KnownFactSchema defines.
      origin: "extracted",
      phaseKey: "problem-validation",
    });
  });

  it("reports an absent key as not established", () => {
    expect(groundFact(buildFactIndex([]), "target_user")).toEqual({
      status: "not-established",
      key: "target_user",
    });
  });

  it("treats a whitespace-only stored value as not established", () => {
    // A heading followed by an empty quote reads as "we looked and found
    // nothing", which is a claim the project never made.
    const index = buildFactIndex([fact("target_user", "   \n  ")]);
    expect(groundFact(index, "target_user").status).toBe("not-established");
  });
});

describe("renderGrounded — absence and doubt are both visible", () => {
  it("names the missing fact key instead of leaving a gap", () => {
    const out = renderGrounded(
      { status: "not-established", key: "price_point" },
      "Price point"
    );
    expect(out).toContain("_not established_");
    expect(out).toContain("`price_point`");
    expect(out).not.toContain(LOW_CONFIDENCE_MARKER);
  });

  it("attaches confidence, phase and fact key to every established claim", () => {
    const index = buildFactIndex([
      fact("price_point", "$29/month", 85, "pricing-economics"),
    ]);
    const out = renderGrounded(groundFact(index, "price_point"), "Price point");
    expect(out).toContain("> $29/month");
    expect(out).toContain("confidence 85/100");
    expect(out).toContain("pricing-economics");
    expect(out).not.toContain(LOW_CONFIDENCE_MARKER);
  });

  it("marks a low-confidence fact rather than presenting it as a finding", () => {
    const index = buildFactIndex([
      fact("price_point", "$29/month", LOW_CONFIDENCE_CEILING - 1),
    ]);
    const out = renderGrounded(groundFact(index, "price_point"), "Price point");
    expect(out).toContain(LOW_CONFIDENCE_MARKER);
    expect(out).toContain("$29/month");
  });

  it("renders a value at exactly the ceiling without a warning", () => {
    const index = buildFactIndex([
      fact("price_point", "$29/month", LOW_CONFIDENCE_CEILING),
    ]);
    const out = renderGrounded(groundFact(index, "price_point"), "Price point");
    expect(out).not.toContain(LOW_CONFIDENCE_MARKER);
  });
});

describe("missingFromVerdict — degrade, but never invent", () => {
  it("reads the gap list from a well-formed verdict", () => {
    expect(
      missingFromVerdict({
        decision: "BLOCK",
        perCriterion: [],
        missing: ["no workaround was named"],
        nextQuestion: "What do they do today?",
        reason: "1 of 8 exit criteria are unmet.",
      })
    ).toEqual(["no workaround was named"]);
  });

  it.each([
    null,
    undefined,
    42,
    "BLOCK",
    {},
    { missing: "oops" },
  ])("returns no gaps rather than throwing for %j", (blob) => {
    // An export that dies because one historical row has an unexpected shape
    // would be a spectacular own goal. Degrade — but to NOTHING, never to a
    // fabricated gap.
    expect(missingFromVerdict(blob)).toEqual([]);
  });
});

describe("phaseStateFor — an unevaluated phase is never 'probably fine'", () => {
  it("defaults a phase with no row to locked and un-decided", () => {
    expect(phaseStateFor([], "positioning")).toEqual({
      phaseKey: "positioning",
      status: "locked",
      decision: null,
      reason: null,
      nextQuestion: null,
      missing: [],
    });
  });

  it("distinguishes a warned pass from a clean one in the label", () => {
    expect(phaseStatusLabel("passed", "PASS")).toBe("passed");
    expect(phaseStatusLabel("passed", "WARN")).toBe("passed (with warnings)");
    expect(phaseStatusLabel("active", "BLOCK")).toBe(
      "in progress — last gate BLOCK"
    );
    expect(phaseStatusLabel("locked", null)).toBe("not started");
  });
});

describe("decideExportReadiness — the empty-set guard", () => {
  it("reports empty for a project with no facts", () => {
    const readiness = decideExportReadiness({ facts: [], phases: [] });
    expect(readiness.level).toBe("empty");
    expect(readiness.reason).toContain("0 stored facts");
  });

  it("reports partial when some phases passed", () => {
    const readiness = decideExportReadiness({
      facts: [fact("target_user", "dog walkers")],
      phases: [passed("problem-validation")],
    });
    expect(readiness.level).toBe("partial");
    expect(readiness.passedPhaseKeys).toEqual(["problem-validation"]);
  });

  it("reports complete only when every phase's stored status is passed", () => {
    const readiness = decideExportReadiness({
      facts: [fact("target_user", "dog walkers")],
      phases: PHASES.map((phase) => passed(phase.key)),
    });
    expect(readiness.level).toBe("complete");
    expect(readiness.passedPhaseKeys).toHaveLength(PHASE_COUNT);
  });

  it("does NOT count a PASS verdict that was never committed as a transition", () => {
    // A verdict is not a transition. Treating one as the other would let the
    // export claim a phase was cleared when the runtime never agreed.
    const readiness = decideExportReadiness({
      facts: [fact("target_user", "dog walkers")],
      phases: PHASES.map((phase) => ({
        phaseKey: phase.key,
        status: "active" as const,
        decision: "PASS" as const,
        reason: "All exit criteria met.",
        nextQuestion: null,
        missing: [],
      })),
    });
    expect(readiness.level).toBe("partial");
    expect(readiness.passedPhaseKeys).toEqual([]);
  });
});

describe("buildDocumentContext — the derived view", () => {
  const context = buildDocumentContext({
    project: { name: "Dog Walker Ops", instructions: "" },
    repoName: "dog-walker-ops",
    facts: [
      fact("target_user", "urban dog walkers", 90),
      fact("problem_statement", "route planning wastes 3h/week", 95),
      fact("price_point", "$29/month", 20, "pricing-economics"),
      fact("legacy_market_size", "$4bn", 99, "problem-validation"),
    ],
    phases: [passed("problem-validation")],
    generatedAt: new Date("2026-03-02T23:30:00.000Z"),
  });

  it("splits keys into established, missing and low-confidence", () => {
    expect(context.lowConfidenceKeys).toEqual(["price_point"]);
    expect(context.notEstablishedKeys).toContain("validation_score");
    expect(context.notEstablishedKeys).not.toContain("target_user");
  });

  it("quarantines keys no phase defines rather than dropping them", () => {
    expect(context.unrecognizedKeys).toEqual(["legacy_market_size"]);
  });

  it("lists missing keys in phase order, not alphabetically", () => {
    const order = allWorkflowFactKeys();
    const positions = context.notEstablishedKeys.map((key) =>
      order.indexOf(key)
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("formats the date in UTC so two machines agree", () => {
    // 23:30 UTC is already the NEXT day in Auckland. Local formatting would
    // make the same snapshot produce two different files.
    expect(context.generatedOn).toBe("2026-03-02");
    expect(formatUtcDate(new Date("2026-12-31T23:59:59.999Z"))).toBe(
      "2026-12-31"
    );
  });
});
