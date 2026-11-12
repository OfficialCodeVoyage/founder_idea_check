import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  createModelFactExtractor,
  createModelGateJudge,
  type ModelUsage,
} from "./model-adapters";

/**
 * model-adapters.ts is one of the two model-bound modules in lib/phases, and it
 * had no coverage at all — which is how the strict-JSON-schema regression
 * documented at the top of the file reached production and turned every gate
 * call into a fail-closed BLOCK.
 *
 * It is testable exactly the way gate.ts is: the model is a parameter, so
 * MockLanguageModelV3 drives the whole adapter with NO API KEY, NO NETWORK and
 * NO DATABASE. Nothing here is mocked out — the real generateText, the real
 * Output.object parsing and the real Zod schemas all run.
 */

/**
 * ai@6 BREAKING, learned in gate.test.ts and repeated here on purpose:
 * finishReason is { unified, raw }, not "stop", and usage token counts are
 * per-category objects. A bare "stop" makes generateText skip structured-output
 * parsing and `result.output` then throws AI_NoOutputGeneratedError.
 */
function mockModel(body: string, usage?: { input: number; output: number }) {
  return new MockLanguageModelV3({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: "text" as const, text: body }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: usage?.input ?? 3,
            noCache: usage?.input ?? 3,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: {
            total: usage?.output ?? 10,
            text: usage?.output ?? 10,
            reasoning: 0,
          },
        },
        warnings: [],
      }),
  });
}

function failingModel(message: string) {
  return new MockLanguageModelV3({
    doGenerate: () => Promise.reject(new Error(message)),
  });
}

const ONE_EVALUATION = JSON.stringify({
  evaluations: [
    {
      criterionId: "problem-statement",
      status: "unmet",
      evidence: "the founder never named who has the problem",
      gap: "nobody has been named as having the problem",
      nextQuestion: "Who exactly has this problem?",
      confidence: 80,
    },
  ],
});

const ONE_FACT = JSON.stringify({
  facts: [
    {
      key: "problem_statement",
      value: "Practice managers rework rejected dental claims for 8h a week",
      evidence: "I spend a day a week redoing rejected claims",
      confidence: 85,
    },
  ],
});

describe("createModelGateJudge", () => {
  it("returns the parsed judge output", async () => {
    const judge = createModelGateJudge({ model: mockModel(ONE_EVALUATION) });

    const output = (await judge({
      system: "you are the judge",
      prompt: "## Exit criteria to judge",
      criteria: [],
    })) as { evaluations: { criterionId: string; status: string }[] };

    expect(output.evaluations).toHaveLength(1);
    expect(output.evaluations[0].criterionId).toBe("problem-statement");
    expect(output.evaluations[0].status).toBe("unmet");
  });

  it("sends the system and prompt it was handed, unmodified", async () => {
    const model = mockModel(ONE_EVALUATION);
    const judge = createModelGateJudge({ model });

    await judge({
      system: "PERSONA TEXT",
      prompt: "TRANSCRIPT TEXT",
      criteria: [],
    });

    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0];
    const serialized = JSON.stringify(call.prompt);
    expect(serialized).toContain("PERSONA TEXT");
    expect(serialized).toContain("TRANSCRIPT TEXT");
  });

  it("relaxes OpenAI strict JSON schema — the regression that broke every gate call", async () => {
    // The judge schema uses Zod .default() so a slightly-off response fails
    // closed with a readable reason. A defaulted field is emitted as OPTIONAL,
    // and strict mode rejects any object whose `required` is not every key in
    // `properties`. With strict mode on, EVERY gate call 400d and the phase
    // fell to a fail-closed BLOCK.
    const model = mockModel(ONE_EVALUATION);
    await createModelGateJudge({ model })({
      system: "s",
      prompt: "p",
      criteria: [],
    });

    expect(model.doGenerateCalls[0].providerOptions).toEqual({
      openai: { strictJsonSchema: false },
    });
  });

  it("reports usage to the sink, tagged with the seam that spent it", async () => {
    const spent: ModelUsage[] = [];
    const judge = createModelGateJudge({
      model: mockModel(ONE_EVALUATION, { input: 1234, output: 56 }),
      onUsage: (usage) => spent.push(usage),
    });

    await judge({ system: "s", prompt: "p", criteria: [] });

    expect(spent).toEqual([
      {
        functionId: "phase-gate",
        inputTokens: 1234,
        outputTokens: 56,
        totalTokens: 1290,
      },
    ]);
  });

  it("works with no usage sink at all", async () => {
    const judge = createModelGateJudge({ model: mockModel(ONE_EVALUATION) });
    await expect(
      judge({ system: "s", prompt: "p", criteria: [] })
    ).resolves.toBeDefined();
  });

  it("propagates a model failure rather than swallowing it", async () => {
    // evaluateGate turns a rejection into a fail-closed BLOCK. It can only do
    // that if the adapter actually rejects — a swallowed error here would look
    // like a clean verdict.
    const judge = createModelGateJudge({ model: failingModel("gateway 503") });

    await expect(
      judge({ system: "s", prompt: "p", criteria: [] })
    ).rejects.toThrow("gateway 503");
  });

  it("charges a reply that fails the schema, and still rejects so the gate BLOCKs", async () => {
    // The provider answered and was paid; the reply was not JSON. The SDK
    // throws from inside generateText, so there is no response to read usage
    // from — it has to come off the error, or the call rides free.
    const spent: ModelUsage[] = [];
    const judge = createModelGateJudge({
      model: mockModel("not json at all", { input: 900, output: 30 }),
      onUsage: (usage) => spent.push(usage),
    });

    await expect(
      judge({ system: "s", prompt: "p", criteria: [] })
    ).rejects.toThrow("No object generated");
    expect(spent).toEqual([
      {
        functionId: "phase-gate",
        inputTokens: 900,
        outputTokens: 30,
        totalTokens: 930,
      },
    ]);
  });

  it("reports nothing for a call that failed before the provider answered", async () => {
    const spent: ModelUsage[] = [];
    const judge = createModelGateJudge({
      model: failingModel("gateway 503"),
      onUsage: (usage) => spent.push(usage),
    });

    await expect(
      judge({ system: "s", prompt: "p", criteria: [] })
    ).rejects.toThrow("gateway 503");
    expect(spent).toEqual([]);
  });
});

describe("createModelFactExtractor", () => {
  it("returns the parsed extraction output", async () => {
    const extract = createModelFactExtractor({ model: mockModel(ONE_FACT) });

    const output = (await extract({ system: "s", prompt: "p" })) as {
      facts: { key: string; confidence: number }[];
    };

    expect(output.facts).toHaveLength(1);
    expect(output.facts[0].key).toBe("problem_statement");
    expect(output.facts[0].confidence).toBe(85);
  });

  it("relaxes strict JSON schema for the extraction schema too", async () => {
    const model = mockModel(ONE_FACT);
    await createModelFactExtractor({ model })({ system: "s", prompt: "p" });

    expect(model.doGenerateCalls[0].providerOptions).toEqual({
      openai: { strictJsonSchema: false },
    });
  });

  it("reports usage under its own functionId, not the judge's", async () => {
    // The two seams are metered separately on purpose: this is a BYOK product
    // and "the gated workflow felt expensive" needs an attributable number.
    const spent: ModelUsage[] = [];
    await createModelFactExtractor({
      model: mockModel(ONE_FACT, { input: 700, output: 40 }),
      onUsage: (usage) => spent.push(usage),
    })({ system: "s", prompt: "p" });

    expect(spent).toHaveLength(1);
    expect(spent[0].functionId).toBe("phase-extract");
    expect(spent[0].inputTokens).toBe(700);
    expect(spent[0].outputTokens).toBe(40);
  });

  it("propagates a model failure so extractFacts can log it and return []", async () => {
    const extract = createModelFactExtractor({
      model: failingModel("no credit"),
    });

    await expect(extract({ system: "s", prompt: "p" })).rejects.toThrow(
      "no credit"
    );
  });

  it("charges a reply that does not match the extraction schema", async () => {
    const spent: ModelUsage[] = [];
    const extract = createModelFactExtractor({
      model: mockModel(JSON.stringify({ facts: "not a list" }), {
        input: 500,
        output: 20,
      }),
      onUsage: (usage) => spent.push(usage),
    });

    await expect(extract({ system: "s", prompt: "p" })).rejects.toThrow(
      "No object generated"
    );
    expect(spent).toHaveLength(1);
    expect(spent[0].functionId).toBe("phase-extract");
    expect(spent[0].inputTokens).toBe(500);
  });
});
