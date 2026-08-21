import { describe, expect, it } from "vitest";
import config from "@/chat.config";
import { GATEWAY_MODEL_DEFAULTS } from "./ai/gateway-model-defaults";

/**
 * These assert the SHAPE of the tuning surface, not particular models. A model
 * choice is a decision someone can revisit; a knob that silently drives two
 * unrelated things is a defect that outlives the decision.
 */
describe("workflow model knobs", () => {
  it("gives the fact extractor its own knob, separate from chat titles", () => {
    // They point at the same model TODAY, and that is fine. What must hold is
    // that they are separately addressable: `extract` decides which claims in a
    // transcript become facts and what confidence the gate then acts on, while
    // `title` names a chat. Retuning one must never move the other.
    expect(config.ai.workflows.extract).toBeDefined();
    expect(config.ai.workflows.title).toBeDefined();
    expect("extract" in config.ai.workflows).toBe(true);
  });

  it("keeps the gate judge on its own knob too", () => {
    // The gate is the product. It must never share a knob with anything
    // cheaper by accident.
    expect(config.ai.workflows.chat).toBeDefined();
    expect(config.ai.workflows.chat).not.toBe(config.ai.workflows.title);
  });
});

describe("deep research exposes all five roles", () => {
  const dr = config.ai.tools.deepResearch;

  it("configures every role explicitly rather than defaulting four of them", () => {
    expect(dr.researchModel).toBeDefined();
    expect(dr.summarizationModel).toBeDefined();
    expect(dr.compressionModel).toBeDefined();
    expect(dr.finalReportModel).toBeDefined();
    expect(dr.statusUpdateModel).toBeDefined();
  });

  it("puts the two LOSSY stages on the report model, not the cheap one", () => {
    // Summarization and compression decide what survives into the report.
    // Whatever they discard, the final report model cannot recover — it just
    // writes confidently over a thinner evidence base. So they are pinned to
    // the same tier as the report itself, and this test is the reason someone
    // has to think before demoting them.
    expect(dr.summarizationModel).toBe(dr.finalReportModel);
    expect(dr.compressionModel).toBe(dr.finalReportModel);
  });
});

describe("the model picker", () => {
  it("offers no model the provider has deprecated, on ANY gateway", () => {
    // gpt-5.2-chat-latest is still listed by GET /v1/models but 404s on both
    // inference endpoints, so a listing check cannot catch it and a founder who
    // picked it got a chat that could not answer. It was in two curated lists,
    // not one, which is why this sweeps every gateway rather than just openai.
    for (const [gateway, defaults] of Object.entries(GATEWAY_MODEL_DEFAULTS)) {
      const curated: readonly string[] = defaults.curatedDefaults;
      expect(curated, gateway).not.toContain("gpt-5.2-chat-latest");
      expect(curated.length, gateway).toBeGreaterThan(0);
    }
  });

  it("gives every gateway a fact-extractor knob", () => {
    for (const [gateway, defaults] of Object.entries(GATEWAY_MODEL_DEFAULTS)) {
      expect(defaults.workflows.extract, gateway).toBeDefined();
    }
  });

  it("gives every gateway all five deep-research roles", () => {
    for (const [gateway, defaults] of Object.entries(GATEWAY_MODEL_DEFAULTS)) {
      const dr = defaults.tools.deepResearch;
      for (const role of [
        "researchModel",
        "summarizationModel",
        "compressionModel",
        "finalReportModel",
        "statusUpdateModel",
      ] as const) {
        expect(dr[role], `${gateway}.${role}`).toBeDefined();
      }
    }
  });
});
