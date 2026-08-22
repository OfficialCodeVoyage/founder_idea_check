import { generateText, Output } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { PHASE_ONE, PHASES } from "./definitions";
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
const RE_INSTRUMENT = /what is the protocol that will produce it/i;
const RE_NEEDS_FIELD_DATA = /need field data that does not exist yet/;

const gate = GateConfigSchema.parse({});

const ALL_META: GateCriterionMeta[] = PHASE_ONE.exitCriteria.map((c) => ({
  id: c.id,
  severity: c.severity,
  closure: c.closure,
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
    // THE JUDGE'S QUESTION IS DISCARDED HERE, ON PURPOSE. `willingness-to-pay`
    // is `offline-only`, and "Who has paid for a workaround, and how much?" is
    // a question about the world that a pre-revenue founder cannot answer
    // without fieldwork. The gate substitutes the instrument.
    expect(verdict.nextQuestion).not.toBe(
      "Who has paid for a workaround, and how much?"
    );
    expect(verdict.nextQuestion).toContain("willingness-to-pay");
    expect(verdict.nextQuestion).toContain("threshold");
    expect(verdict.obstacle).toEqual({
      kind: "fieldwork-required",
      criterionIds: ["willingness-to-pay"],
    });

    // The judge was actually given the criteria, not a summary of them.
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain(
      "existing-workarounds"
    );
  });
});

/**
 * THE DEADLOCK, AND THE INVARIANT THAT ENDS IT.
 *
 * Live evidence, 2026-08-21: project 01a0279c sat on `problem-validation` for
 * SEVEN attempts, BLOCK every time, and attempt 7's own nextQuestion asked the
 * founder "what evidence-backed 1-5 scores do frequency, intensity, workarounds
 * and willingness to pay receive?" — four typed integers away from PASS, on
 * numbers nobody had measured. The founder refused twice, correctly:
 *
 *   "I am not going to hypothesize scores for interviews that have not
 *    happened. Answering that question would fabricate the exact evidence this
 *    phase exists to collect."
 *
 * The gate was asking for the laundering it exists to prevent.
 */
describe("decideGate — a gap that needs fieldwork", () => {
  /** The four rubric dimensions, unmet, with the judge asking for the values. */
  function attemptSeven(): CriterionEvaluation[] {
    const asks: Record<string, string> = {
      "frequency-and-intensity":
        "What 1-5 scores do frequency and intensity receive?",
      "existing-workarounds": "What 1-5 score do workarounds receive?",
      "willingness-to-pay": "What 1-5 score does willingness to pay receive?",
      "validation-score": "What is the product of the four scores?",
    };
    return allMet().map((e) =>
      asks[e.criterionId]
        ? ev(e.criterionId, "unmet", {
            gap: `${e.criterionId} has no evidence behind it`,
            nextQuestion: asks[e.criterionId],
          })
        : e
    );
  }

  it("STILL BLOCKS — nothing about this advances a phase", () => {
    const verdict = decideGate(attemptSeven(), {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });
    expect(verdict.decision).toBe("BLOCK");
  });

  it("refuses to re-ask for the scores, and asks for the instrument instead", () => {
    const verdict = decideGate(attemptSeven(), {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    // Not one of the judge's four armchair-answerable questions survives.
    for (const ask of [
      "What 1-5 scores do frequency and intensity receive?",
      "What 1-5 score do workarounds receive?",
      "What 1-5 score does willingness to pay receive?",
      "What is the product of the four scores?",
    ]) {
      expect(verdict.nextQuestion).not.toBe(ask);
    }
    // And what replaces them is about producing the evidence, not stating it.
    expect(verdict.nextQuestion).toMatch(RE_INSTRUMENT);
    expect(verdict.nextQuestion).toContain("threshold");
  });

  it("names the arm as fieldwork-required, not as a plain missing gap", () => {
    const verdict = decideGate(attemptSeven(), {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });
    expect(verdict.obstacle?.kind).toBe("fieldwork-required");
    expect(verdict.obstacle?.criterionIds).toEqual([
      "frequency-and-intensity",
      "existing-workarounds",
      "willingness-to-pay",
      "validation-score",
    ]);
    // The gaps themselves are unchanged — the refusal is still named in full.
    expect(verdict.missing).toHaveLength(4);
  });

  it("keeps the gate's own reason honest about why it refused", () => {
    const verdict = decideGate(attemptSeven(), {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });
    expect(verdict.reason).toMatch(RE_NEEDS_FIELD_DATA);
  });

  /**
   * THE PRIORITY RULE. A criterion the founder could close by answering is
   * always asked first, because it is genuinely closable this turn. Switching to
   * the instrument while something answerable is still open would stall a
   * founder who had an answer ready.
   */
  it("prefers a question the founder CAN answer when one is still open", () => {
    const perCriterion = attemptSeven().map((e) =>
      e.criterionId === "target-user"
        ? ev(e.criterionId, "unmet", {
            gap: "no buyer is named",
            nextQuestion: "Who exactly, by role, feels this?",
          })
        : e
    );
    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.nextQuestion).toBe("Who exactly, by role, feels this?");
    expect(verdict.obstacle?.kind).toBe("evidence-missing");
  });

  it("applies the invariant to a blocking PARTIAL too", () => {
    const perCriterion = allMet().map((e) =>
      e.criterionId === "frequency-and-intensity"
        ? ev(e.criterionId, "partial", {
            gap: "intensity is asserted, not evidenced",
            nextQuestion: "What score does intensity get?",
          })
        : e
    );
    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.nextQuestion).not.toBe("What score does intensity get?");
    expect(verdict.nextQuestion).toMatch(RE_INSTRUMENT);
    expect(verdict.obstacle?.kind).toBe("fieldwork-required");
  });

  it("still asks for the value when the criterion is answerable in conversation", () => {
    // `problem-statement` is in-conversation: the founder knows it and has not
    // said it. Nothing about this change may make the gate stop asking for it.
    const perCriterion = allMet().map((e) =>
      e.criterionId === "problem-statement"
        ? ev(e.criterionId, "unmet", {
            gap: "the problem is stated as a product idea",
            nextQuestion: "Whose day goes wrong, and what happens?",
          })
        : e
    );
    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    expect(verdict.nextQuestion).toBe(
      "Whose day goes wrong, and what happens?"
    );
    expect(verdict.obstacle?.kind).toBe("evidence-missing");
  });

  /**
   * The phase-4 case, which is the reason `pre-registered-threshold` is
   * classified in-conversation while everything around it is offline-only:
   * stating the threshold BEFORE the test is exactly the move the gate wants,
   * so it must remain a question the gate is willing to ask.
   */
  it("asks phase 4 for its pre-registered threshold rather than for results", () => {
    const phaseFour = PHASES[3];
    const meta: GateCriterionMeta[] = phaseFour.exitCriteria.map((c) => ({
      id: c.id,
      severity: c.severity,
      closure: c.closure,
    }));
    const perCriterion = meta.map((c) =>
      ev(c.id, "unmet", {
        gap: `${c.id} has nothing behind it`,
        nextQuestion: `Tell me the result for ${c.id}.`,
      })
    );

    const verdict = decideGate(perCriterion, {
      criteria: meta,
      gate,
      factCount: 9,
    });

    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.nextQuestion).toBe(
      "Tell me the result for pre-registered-threshold."
    );
    expect(verdict.obstacle?.kind).toBe("evidence-missing");
  });

  it("separates not-evaluable from unmet in the arm it reports", () => {
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
    expect(verdict.obstacle).toEqual({
      kind: "not-evaluable",
      criterionIds: ["evidence-quality"],
    });
  });

  it("gives every non-criterion refusal its own arm", () => {
    expect(
      decideGate([], { criteria: [], gate, factCount: 9 }).obstacle?.kind
    ).toBe("phase-misconfigured");
    expect(
      decideGate([], { criteria: ALL_META, gate, factCount: 9 }).obstacle?.kind
    ).toBe("judge-incomplete");
    expect(
      decideGate(allMet(), { criteria: ALL_META, gate, factCount: 0 }).obstacle
        ?.kind
    ).toBe("no-facts-yet");
    expect(
      decideGate(allMet().slice(0, 6), {
        criteria: ALL_META,
        gate,
        factCount: 9,
      }).obstacle?.kind
    ).toBe("judge-incomplete");
  });

  it("carries no obstacle on a PASS — there is nothing in the way", () => {
    expect(
      decideGate(allMet(), { criteria: ALL_META, gate, factCount: 9 }).obstacle
    ).toBeNull();
    expect(
      decideGate(allMet(), {
        criteria: ALL_META,
        gate: GateConfigSchema.parse({ enabled: false }),
        factCount: 9,
      }).obstacle
    ).toBeNull();
  });

  it("reports an advisory-only miss as advisory-only, not as a blocker", () => {
    const perCriterion = allMet().map((e) =>
      e.criterionId === "people-interviewed"
        ? ev(e.criterionId, "unmet", { gap: "only 2 people spoken to" })
        : e
    );
    const verdict = decideGate(perCriterion, {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

    expect(verdict.decision).toBe("WARN");
    expect(verdict.obstacle?.kind).toBe("advisory-only");
  });

  /**
   * THE ONE THING THIS CHANGE MAY NOT DO. `fieldwork-required` is a new arm on a
   * BLOCK, never a new way through. Every combination of closures over an unmet
   * blocking criterion must still refuse.
   */
  it("never lets a closure classification reach PASS", () => {
    for (const closure of ["in-conversation", "offline-only"] as const) {
      const meta: GateCriterionMeta[] = ALL_META.map((c) => ({
        ...c,
        closure,
      }));
      for (const status of ["unmet", "partial", "not-evaluable"] as const) {
        const perCriterion = allMet().map((e) =>
          e.criterionId === "problem-statement"
            ? ev(e.criterionId, status, { gap: "nothing here" })
            : e
        );
        const verdict = decideGate(perCriterion, {
          criteria: meta,
          gate,
          factCount: 9,
        });
        expect(verdict.decision).toBe("BLOCK");
      }
    }
  });
});

/**
 * THE OSCILLATION, WHICH WAS NEVER AN OSCILLATION.
 *
 * QA-BACKLOG §3 records the verdicts moving 5 → 1 → 1 → 1 → 5 → 5 → 1 across
 * seven attempts and reads it as the founder closing four criteria and watching
 * them re-open twice. Replaying the seven stored rows out of ProjectPhaseAttempt
 * shows nothing of the kind. FIVE criteria were `unmet` on every single attempt;
 * the true count of not-met criteria was 8 → 8 → 8 → 7 → 7 → 6 → 7, monotone
 * progress with one real regression.
 *
 * The whole reported series was `validation-score` alone flipping between
 * "not-evaluable" and "unmet". decideGate returns on the first matching rule and
 * the not-evaluable rule sits above the unmet rule, so that one label decided
 * whether the founder was told about one gap or six. The gate was concealing its
 * own findings and then reporting the concealment as movement.
 */
describe("decideGate — the headline may not move on one label", () => {
  /** Attempt 4 as stored: 5 unmet, 1 not-evaluable, 1 partial, 1 met. */
  function attemptFour(
    status: "not-evaluable" | "unmet"
  ): CriterionEvaluation[] {
    const unmet = [
      "frequency-and-intensity",
      "existing-workarounds",
      "willingness-to-pay",
      "evidence-quality",
      "people-interviewed",
    ];
    return allMet().map((e) => {
      if (e.criterionId === "validation-score") {
        return ev(e.criterionId, status, { gap: "four rubric scores" });
      }
      if (unmet.includes(e.criterionId)) {
        return ev(e.criterionId, "unmet", {
          gap: `${e.criterionId} has nothing`,
        });
      }
      if (e.criterionId === "problem-statement") {
        return ev(e.criterionId, "partial", { gap: "the statement is broad" });
      }
      return e;
    });
  }

  const decide = (status: "not-evaluable" | "unmet") =>
    decideGate(attemptFour(status), {
      criteria: ALL_META,
      gate,
      factCount: 9,
    });

  it("reports the SAME open set whichever label the judge picked", () => {
    const asNotEvaluable = decide("not-evaluable");
    const asUnmet = decide("unmet");

    // This is the assertion that would have caught it. Before the fix these
    // were 1 and 6.
    expect(asNotEvaluable.missing).toEqual(asUnmet.missing);
    expect(asNotEvaluable.missing).toHaveLength(6);
    expect(asUnmet.missing).toHaveLength(6);
  });

  it("never hides an unmet criterion behind a not-evaluable one", () => {
    const v = decide("not-evaluable");
    // people-interviewed is ADVISORY, so it is not in the blocking open set;
    // the other four unmet criteria and the partial all are.
    for (const gap of [
      "frequency-and-intensity has nothing",
      "existing-workarounds has nothing",
      "willingness-to-pay has nothing",
      "evidence-quality has nothing",
      "the statement is broad",
    ]) {
      expect(v.missing).toContain(gap);
    }
    expect(v.obstacle?.criterionIds).toHaveLength(6);
  });

  it("says in the reason how much is still open beyond what decided", () => {
    const v = decide("not-evaluable");
    expect(v.reason).toContain("1 of 8 exit criteria could not be assessed");
    // The half that was missing, and the half that made "1 of 8" misleading.
    expect(v.reason).toContain("5 more of the 8 are still open");
  });

  it("still asks the question the founder can actually answer", () => {
    // problem-statement is `in-conversation` and sits at partial, so it is
    // answerable now — and it must be asked even though a not-evaluable
    // offline-only criterion is what decided the verdict.
    const v = decide("not-evaluable");
    expect(v.nextQuestion).toBe(
      "Answer this before we move on: the statement is broad"
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
