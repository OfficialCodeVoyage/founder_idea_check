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

const { getDeepResearchConfig } = await import("./configuration");

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
