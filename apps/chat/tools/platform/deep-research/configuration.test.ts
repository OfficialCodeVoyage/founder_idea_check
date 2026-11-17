import { describe, expect, it, vi } from "vitest";

/**
 * Five roles, five knobs — asserted here because the failure it prevents is
 * invisible. `defaultModel` used to drive summarization, research, compression
 * AND status updates, so a "model change" to deep research silently moved four
 * things at once, two of which decide what evidence survives into the report.
 */
vi.mock("@/lib/config", () => ({
  config: {
    ai: {
      tools: {
        deepResearch: {
          hosted: false,
          researchSidecarUrl: "http://sidecar.test:8099",
          researchModel: "research-m",
          summarizationModel: "summarize-m",
          compressionModel: "compress-m",
          finalReportModel: "report-m",
          statusUpdateModel: "status-m",
          allowClarification: true,
          maxConcurrentResearchUnits: 2,
          maxSearchQueries: 2,
          maxResearcherIterations: 1,
          maxResearcherSteps: 6,
        },
      },
    },
  },
}));

vi.mock("@/lib/env", () => ({
  env: {},
}));

const { getCompressionProviderOptions, getDeepResearchConfig } = await import(
  "./configuration"
);
const { researchSystemPrompt } = await import("./prompts");

describe("deep research threads five DISTINCT model roles", () => {
  it("gives every role its own configured model", () => {
    const config = getDeepResearchConfig();

    expect(config.research_model).toBe("research-m");
    expect(config.summarization_model).toBe("summarize-m");
    expect(config.compression_model).toBe("compress-m");
    expect(config.final_report_model).toBe("report-m");
    expect(config.status_update_model).toBe("status-m");
  });

  it("keeps the two LOSSY roles independently assignable", () => {
    // Summarization and compression decide what the final report model will
    // ever get to see. If either silently followed another knob, the report
    // would be written over a thinner evidence base than anyone chose.
    const config = getDeepResearchConfig();
    const roles = [
      config.summarization_model,
      config.compression_model,
      config.research_model,
      config.status_update_model,
      config.final_report_model,
    ];
    expect(new Set(roles).size).toBe(5);
  });

  it("does not leave any model role undefined", () => {
    // The regression this catches: renaming a config key without updating the
    // destructure leaves `undefined` threaded through to the provider, which
    // fails at call time rather than at config time.
    const config = getDeepResearchConfig();
    for (const role of [
      "research_model",
      "summarization_model",
      "compression_model",
      "final_report_model",
      "status_update_model",
    ] as const) {
      expect(config[role], role).toBeTruthy();
    }
  });

  it("respects the maxResearcherSteps ceiling rather than inheriting 20", () => {
    expect(getDeepResearchConfig().max_researcher_steps).toBe(6);
  });
});

/**
 * GUARD for the live QA run whose researchers each spent 50 to 60 s writing
 * their findings out as a 4,000-token free-text reply (finishReason "length",
 * no tool call) that compression rebuilds from the search results anyway, and
 * pushed the run past its search stop. A researcher step is short by design:
 * a small output ceiling, and a prompt that asks for brief notes.
 */
describe("a researcher's closing step is short by design", () => {
  it("caps one researcher step far below the other roles' 4,000 tokens", () => {
    const config = getDeepResearchConfig();
    // Measured tool-call steps were 145 to 201 output tokens; at about 70
    // tokens/s a 4,000-token step took 57 s, and 2,000 would still be 29 s.
    expect(config.researcher_step_max_tokens).toBeLessThanOrEqual(2000);
    expect(config.researcher_step_max_tokens).toBeGreaterThanOrEqual(600);
    expect(config.researcher_step_max_tokens).toBeLessThan(
      config.research_model_max_tokens
    );
  });

  it("asks the researcher for brief notes, not its findings written out", () => {
    const prompt = researchSystemPrompt({
      date: "today",
      mcp_prompt: "",
      max_search_queries: 2,
    });
    expect(prompt).toContain("brief notes only");
    expect(prompt).not.toContain("provide your final findings as text");
  });
});

/**
 * GUARD for the live QA run whose compression calls spent 1,459, 516 and 375 of
 * their 3,730, 3,300 and 1,931 output tokens on reasoning, one ending 270 short
 * of the 4,000-token cap. The compression call asks for the lowest effort the
 * model takes; the cap itself is the time budget and stays.
 */
describe("the compression call does not spend its output cap on reasoning", () => {
  it("asks the gpt-5.6 family for no reasoning, with or without a gateway prefix", () => {
    const expected = { openai: { reasoningEffort: "none" } };
    expect(getCompressionProviderOptions("gpt-5.6-terra")).toEqual(expected);
    expect(getCompressionProviderOptions("gpt-5.6-luna")).toEqual(expected);
    expect(getCompressionProviderOptions("openai/gpt-5.6-terra")).toEqual(
      expected
    );
  });

  it("sends nothing to a model whose handling of the option is not established", () => {
    expect(getCompressionProviderOptions("gpt-4o-mini")).toBeUndefined();
    expect(getCompressionProviderOptions("claude-opus-5")).toBeUndefined();
    expect(getCompressionProviderOptions("gpt-5.4-mini")).toBeUndefined();
  });

  it("leaves the output cap where it was", () => {
    expect(getDeepResearchConfig().compression_model_max_tokens).toBe(4000);
  });
});
