import { generateText, Output } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { PHASE_ONE } from "./definitions";
import {
  buildGatePrompt,
  decideGate,
  evaluateGate,
  type GateCriterionMeta,
  type GateJudge,
  renderFacts,
} from "./gate";
import {
  type CriterionEvaluation,
  type CriterionStatus,
  GateConfigSchema,
  JudgeOutputSchema,
  type KnownFact,
  type TranscriptTurn,
} from "./types";

const RE_ONE_UNMET = /1 of 8 exit criteria are unmet/;
const RE_NO_CRITERIA_DEFINED = /no exit criteria are defined/i;
const RE_NOTHING_EVALUATED = /No criteria were evaluated \(0 of 8\)/;
const RE_NOTHING_ESTABLISHED = /Nothing has been established/;
const RE_COVERAGE_MISMATCH = /coverage mismatch \(6 evaluations for 8/;
const RE_DUPLICATE = /duplicate evaluations/;
const RE_NOT_ASSESSED = /could not be assessed/;
const RE_GATE_DISABLED = /disabled by configuration/;
const RE_FAILED_CLOSED = /failed closed/;
const RE_NO_API_KEY = /no api key/;
const RE_BAD_SHAPE = /did not match the expected shape/;

const gate = GateConfigSchema.parse({});

const ALL_META: GateCriterionMeta[] = PHASE_ONE.exitCriteria.map((c) => ({
  id: c.id,
  severity: c.severity,
}));

function ev(
  criterionId: string,
  status: CriterionStatus,
  extra: Partial<CriterionEvaluation> = {}
): CriterionEvaluation {
  return {
    criterionId,
    status,
    evidence: extra.evidence ?? "founder said so",
    gap: extra.gap ?? (status === "met" ? null : `${criterionId} is missing`),
    nextQuestion: extra.nextQuestion ?? null,
    confidence: extra.confidence ?? 80,
  };
}

/** All eight criteria met — the baseline a test then perturbs. */
function allMet(): CriterionEvaluation[] {
  return ALL_META.map((c) => ev(c.id, "met"));
}

const FACTS: KnownFact[] = [
  { key: "problem_statement", value: "x", confidence: 80 },
  { key: "target_user", value: "y", confidence: 80 },
];

describe("decideGate — the pure gate", () => {
  it("BLOCKs a vague idea and names the specific gap", () => {
    const gapText =
      "no buyer is named — 'small businesses' is a category, not a person who pays";
    const perCriterion = allMet().map((e) =>
      e.criterionId === "target-user"
        ? ev("target-user", "unmet", {
            gap: gapText,
            nextQuestion: "Who exactly, by role and company size, feels this?",
          })
        : e
    );

    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate,
      factCount: FACTS.length,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.missing).toContain(gapText);
    expect(verdict.reason).toContain(gapText);
    expect(verdict.reason).toMatch(RE_ONE_UNMET);
    expect(verdict.nextQuestion).toBe(
      "Who exactly, by role and company size, feels this?"
    );
  });

  it("names EVERY unmet gap, not just the first", () => {
    const perCriterion = allMet().map((e) => {
      if (e.criterionId === "existing-workarounds") {
        return ev(e.criterionId, "unmet", { gap: "nobody has tried anything" });
      }
      if (e.criterionId === "willingness-to-pay") {
        return ev(e.criterionId, "unmet", {
          gap: "willingness is hypothetical",
        });
      }
      return e;
    });

    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate,
      factCount: 2,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.missing).toEqual([
      "nobody has tried anything",
      "willingness is hypothetical",
    ]);
  });

  it("PASSes a well-evidenced phase", () => {
    const verdict = decideGate(allMet(), {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    expect(verdict.decision).toBe("PASS");
    expect(verdict.missing).toEqual([]);
    expect(verdict.nextQuestion).toBeNull();
    expect(verdict.reason).toBe("All exit criteria met: 8/8 passed.");
  });

  it("BLOCKs when the phase defines zero criteria — the 0/0 guard", () => {
    const verdict = decideGate([], {
      criteria: [],
      gate,
      factCount: 9,
    });

    // 0 of 0 is not 100%. Never PASS. Diverges from warden's WARN on purpose:
    // phase advance is the merge here, there is no second gate downstream.
    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.reason).toMatch(RE_NO_CRITERIA_DEFINED);
  });

  it("BLOCKs when criteria exist but nothing was evaluated", () => {
    const verdict = decideGate([], {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.reason).toMatch(RE_NOTHING_EVALUATED);
  });

  it("BLOCKs when zero facts have been extracted", () => {
    const verdict = decideGate(allMet(), {
      criteria: ALL_META,
      gate,
      factCount: 0,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.reason).toMatch(RE_NOTHING_ESTABLISHED);
    expect(verdict.missing).toEqual([
      "no facts have been established about the project yet",
    ]);
  });

  it("BLOCKs on partial coverage — an unaddressed criterion is unknown", () => {
    const verdict = decideGate(allMet().slice(0, 6), {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.reason).toMatch(RE_COVERAGE_MISMATCH);
    expect(verdict.reason).toContain("validation-score");
  });

  it("BLOCKs on a duplicate criterion id", () => {
    const dup = [...allMet(), ev("target-user", "met")];
    const verdict = decideGate(dup, {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.reason).toMatch(RE_DUPLICATE);
  });

  it("BLOCKs on not-evaluable — unknown fails closed", () => {
    const perCriterion = allMet().map((e) =>
      e.criterionId === "evidence-quality"
        ? ev(e.criterionId, "not-evaluable", { gap: "no sources were named" })
        : e
    );
    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.reason).toMatch(RE_NOT_ASSESSED);
  });

  it("downgrades an unmet status with no named gap to not-evaluable", () => {
    const perCriterion = allMet().map((e) =>
      e.criterionId === "target-user"
        ? ev(e.criterionId, "unmet", { gap: "   " })
        : e
    );
    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(
      verdict.perCriterion.find((e) => e.criterionId === "target-user")?.status
    ).toBe("not-evaluable");
  });

  it("WARNs — advance permitted — when only an advisory criterion misses", () => {
    const perCriterion = allMet().map((e) =>
      e.criterionId === "people-interviewed"
        ? ev(e.criterionId, "unmet", {
            gap: "only 2 people have been spoken to",
          })
        : e
    );
    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    expect(verdict.decision).toBe("WARN");
    expect(verdict.missing).toEqual(["only 2 people have been spoken to"]);
  });

  /**
   * The strictness of the entire product lives here. The judge is an LLM
   * choosing freely between "partial" and "unmet"; if "partial" were a way
   * through, every gate would be one word away from advisory.
   */
  it("BLOCKs on a blocking partial by default — 'partial' is not a way through", () => {
    const perCriterion = allMet().map((e) =>
      e.criterionId === "frequency-and-intensity"
        ? ev(e.criterionId, "partial", {
            gap: "intensity is asserted, not evidenced",
          })
        : e
    );
    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate, // tolerateBlockingPartials defaults to 0
      factCount: 9,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.missing).toEqual(["intensity is asserted, not evidenced"]);
  });

  it("WARNs — never PASSes — on a blocking partial the phase explicitly tolerates", () => {
    const perCriterion = allMet().map((e) =>
      e.criterionId === "frequency-and-intensity"
        ? ev(e.criterionId, "partial", {
            gap: "intensity is asserted, not evidenced",
          })
        : e
    );
    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate: GateConfigSchema.parse({ tolerateBlockingPartials: 1 }),
      factCount: 9,
    });

    // Tolerated, so advance is permitted — but the gap stays visible, and the
    // verdict must not claim every criterion was met.
    expect(verdict.decision).toBe("WARN");
    expect(verdict.missing).toEqual(["intensity is asserted, not evidenced"]);
  });

  it("PASSes with gate.enabled = false, when the phase does define criteria", () => {
    const verdict = decideGate(allMet(), {
      criteria: ALL_META,
      gate: GateConfigSchema.parse({ enabled: false }),
      factCount: 9,
    });

    expect(verdict.decision).toBe("PASS");
    expect(verdict.reason).toMatch(RE_GATE_DISABLED);
  });

  /**
   * Misconfiguration beats operator opt-out. A phase with no exit criteria is a
   * bug in the phase definition, and `enabled: false` must not paper over it —
   * otherwise a typo silently certifies a founder past validation.
   */
  it("BLOCKs a phase with zero criteria even when the gate is disabled", () => {
    const verdict = decideGate([], {
      criteria: [],
      gate: GateConfigSchema.parse({ enabled: false }),
      factCount: 0,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.reason).not.toMatch(RE_GATE_DISABLED);
  });
});

describe("buildGatePrompt — the judge sees the right criteria", () => {
  const input = {
    phase: PHASE_ONE,
    personaPrompt: "PERSONA",
    phasePrompt: "PHASE",
    transcript: [
      { role: "user", text: "an app for dog walkers" },
    ] as TranscriptTurn[],
    facts: FACTS,
  };

  it("includes every criterion id and description", () => {
    const { prompt } = buildGatePrompt(input);
    for (const c of PHASE_ONE.exitCriteria) {
      expect(prompt).toContain(c.id);
      expect(prompt).toContain(c.description);
    }
  });

  it("renders the metric-threshold operator and value literally", () => {
    const { prompt } = buildGatePrompt(input);
    expect(prompt).toContain("validation_score ≥ 100");
    expect(prompt).toContain("people_interviewed ≥ 5");
  });

  it("carries the persona and phase prompts into the system message", () => {
    const { system } = buildGatePrompt(input);
    expect(system).toContain("PERSONA");
    expect(system).toContain("PHASE");
  });
});

describe("evaluateGate — the injected seam", () => {
  const input = {
    phase: PHASE_ONE,
    personaPrompt: "PERSONA",
    phasePrompt: "PHASE",
    transcript: [{ role: "user", text: "hi" }] as TranscriptTurn[],
    facts: FACTS,
  };

  it("delegates a fake judge's evaluations to decideGate", async () => {
    const judge: GateJudge = () =>
      Promise.resolve({
        evaluations: allMet().map((e) =>
          e.criterionId === "existing-workarounds"
            ? ev(e.criterionId, "unmet", { gap: "nobody has tried anything" })
            : e
        ),
      });

    const verdict = await evaluateGate({ judge }, input);
    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.missing).toEqual(["nobody has tried anything"]);
  });

  it("fails CLOSED when the judge throws", async () => {
    const judge: GateJudge = () => Promise.reject(new Error("no api key"));
    const verdict = await evaluateGate({ judge }, input);

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.reason).toMatch(RE_FAILED_CLOSED);
    expect(verdict.reason).toMatch(RE_NO_API_KEY);
  });

  it("fails CLOSED when the judge returns an unrecognized shape", async () => {
    const judge: GateJudge = () => Promise.resolve({ verdict: "looks fine!" });
    const verdict = await evaluateGate({ judge }, input);

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.reason).toMatch(RE_BAD_SHAPE);
  });

  it("runs end to end against a mock model, with no API key", async () => {
    const body = JSON.stringify({
      evaluations: allMet().map((e) =>
        e.criterionId === "willingness-to-pay"
          ? ev(e.criterionId, "unmet", {
              gap: "nobody has named a price they would pay",
              nextQuestion: "Who has paid for a workaround, and how much?",
            })
          : e
      ),
    });

    const model = new MockLanguageModelV3({
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: "text" as const, text: body }],
          // ai@6 BREAKING: finishReason is { unified, raw }, NOT the string
          // "stop". With a bare "stop", generateText never parses structured
          // output and result.output throws AI_NoOutputGeneratedError.
          finishReason: { unified: "stop" as const, raw: "stop" },
          // ai@6 BREAKING: usage token counts are per-category objects, not
          // bare numbers ({ inputTokens: 3 } no longer type-checks).
          usage: {
            inputTokens: {
              total: 3,
              noCache: 3,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: { total: 10, text: 10, reasoning: 0 },
          },
          warnings: [],
        }),
    });

    const judge: GateJudge = async ({ system, prompt }) => {
      const response = await generateText({
        model,
        system,
        prompt,
        output: Output.object({ schema: JudgeOutputSchema }),
      });
      return response.output;
    };

    const verdict = await evaluateGate({ judge }, input);

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.missing).toEqual([
      "nobody has named a price they would pay",
    ]);
    expect(verdict.nextQuestion).toBe(
      "Who has paid for a workaround, and how much?"
    );

    // The judge was actually given the criteria, not a summary of them.
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain(
      "existing-workarounds"
    );
  });
});

describe("renderFacts — the judge can tell who asserted what", () => {
  it("marks a founder-corrected fact so it cannot read as extracted evidence", () => {
    // The whole reason the provenance column exists. A judge that cannot tell
    // the two apart can be passed on an assumption the founder typed
    // themselves — the exact failure this product exists to prevent.
    const rendered = renderFacts([
      { key: "buyer_role", value: "office manager", confidence: 60 },
      {
        key: "price_point",
        value: "$200/mo",
        confidence: 40,
        origin: "founder",
      },
    ]);
    expect(rendered).toContain("- buyer_role: office manager (confidence 60)");
    expect(rendered).toContain("asserted by the founder, not extracted");
  });

  it("renders an extracted fact byte-for-byte as before", () => {
    // No existing prompt or fixture may shift. The marker is additive.
    const explicit = renderFacts([
      { key: "k", value: "v", confidence: 50, origin: "extracted" },
    ]);
    const omitted = renderFacts([{ key: "k", value: "v", confidence: 50 }]);
    expect(explicit).toBe("- k: v (confidence 50)");
    expect(omitted).toBe(explicit);
  });
});
