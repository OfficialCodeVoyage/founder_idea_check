import { describe, expect, it, vi } from "vitest";

// Mock app-models to return test pricing
vi.mock("../ai/app-models", () => ({
  getAppModelDefinition: vi.fn().mockImplementation((modelId: string) => {
    const models: Record<
      string,
      { pricing?: { input: string; output: string } }
    > = {
      "test-model": { pricing: { input: "0.00001", output: "0.00003" } },
      "claude-sonnet": { pricing: { input: "0.000003", output: "0.000015" } },
      "gpt-4o": { pricing: { input: "0.0000025", output: "0.00001" } },
      "no-pricing": {},
    };
    return Promise.resolve(models[modelId] || {});
  }),
}));

const { CostAccumulator } = await import("./cost-accumulator");

describe("CostAccumulator", () => {
  describe("LLM cost calculation", () => {
    it("should calculate cost from tokens and pricing", async () => {
      const accumulator = new CostAccumulator();
      accumulator.addLLMCost(
        "test-model" as any,
        { inputTokens: 1000, outputTokens: 500 },
        "test"
      );

      const cost = (await accumulator.settle()).cents;
      // 1000 * 0.00001 = 0.01 (input)
      // 500 * 0.00003 = 0.015 (output)
      // Total = 0.025 dollars = 2.5 cents, ceil = 3
      expect(cost).toBe(3);
    });

    it("should return 0 for zero tokens", async () => {
      const accumulator = new CostAccumulator();
      accumulator.addLLMCost(
        "test-model" as any,
        { inputTokens: 0, outputTokens: 0 },
        "test"
      );

      const cost = (await accumulator.settle()).cents;
      expect(cost).toBe(0);
    });

    it("should handle undefined tokens as zero", async () => {
      const accumulator = new CostAccumulator();
      accumulator.addLLMCost("test-model" as any, {}, "test");

      const cost = (await accumulator.settle()).cents;
      expect(cost).toBe(0);
    });

    it("should handle Claude 3.5 Sonnet pricing", async () => {
      const accumulator = new CostAccumulator();
      accumulator.addLLMCost(
        "claude-sonnet" as any,
        { inputTokens: 10_000, outputTokens: 1000 },
        "test"
      );

      const cost = (await accumulator.settle()).cents;
      // 10000 * 0.000003 = 0.03 (input)
      // 1000 * 0.000015 = 0.015 (output)
      // Total = 0.045 dollars = 4.5 cents, ceil = 5
      expect(cost).toBe(5);
    });

    it("should handle GPT-4o pricing", async () => {
      const accumulator = new CostAccumulator();
      accumulator.addLLMCost(
        "gpt-4o" as any,
        { inputTokens: 100_000, outputTokens: 10_000 },
        "test"
      );

      const cost = (await accumulator.settle()).cents;
      // 100000 * 0.0000025 = 0.25 (input)
      // 10000 * 0.00001 = 0.1 (output)
      // Total = 0.35 dollars = 35 cents
      expect(cost).toBe(35);
    });

    it("should skip models without pricing", async () => {
      const accumulator = new CostAccumulator();
      accumulator.addLLMCost(
        "no-pricing" as any,
        { inputTokens: 1000, outputTokens: 500 },
        "test"
      );

      const cost = (await accumulator.settle()).cents;
      expect(cost).toBe(0);
    });
  });

  describe("API cost tracking", () => {
    it("should add API costs", async () => {
      const accumulator = new CostAccumulator();
      accumulator.addAPICost("webSearch", 5);

      const cost = (await accumulator.settle()).cents;
      expect(cost).toBe(5);
    });

    it("should ignore zero API costs", () => {
      const accumulator = new CostAccumulator();
      accumulator.addAPICost("internal", 0);

      expect(accumulator.hasEntries()).toBe(false);
    });
  });

  describe("combined costs", () => {
    it("should sum LLM and API costs", async () => {
      const accumulator = new CostAccumulator();
      accumulator.addLLMCost(
        "test-model" as any,
        { inputTokens: 1000, outputTokens: 500 },
        "chat"
      );
      accumulator.addAPICost("webSearch", 5);

      const cost = (await accumulator.settle()).cents;
      // LLM: 2.5 cents + API: 5 cents = 7.5, ceil = 8
      expect(cost).toBe(8);
    });

    it("should accumulate multiple LLM calls", async () => {
      const accumulator = new CostAccumulator();
      accumulator.addLLMCost(
        "test-model" as any,
        { inputTokens: 1000, outputTokens: 500 },
        "main"
      );
      accumulator.addLLMCost(
        "test-model" as any,
        { inputTokens: 1000, outputTokens: 500 },
        "tool"
      );

      const cost = (await accumulator.settle()).cents;
      // 2.5 + 2.5 = 5 cents
      expect(cost).toBe(5);
    });
  });

  describe("getEntries", () => {
    it("should return copy of entries", () => {
      const accumulator = new CostAccumulator();
      accumulator.addAPICost("test", 5);

      const entries = accumulator.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ type: "api", apiName: "test", cost: 5 });
    });
  });

  describe("hasEntries", () => {
    it("should return false when empty", () => {
      const accumulator = new CostAccumulator();
      expect(accumulator.hasEntries()).toBe(false);
    });

    it("should return true when has entries", () => {
      const accumulator = new CostAccumulator();
      accumulator.addAPICost("test", 5);
      expect(accumulator.hasEntries()).toBe(true);
    });
  });
});

describe("settle() names what it could not price", () => {
  it("prices a real model from the static table when the gateway reports none", async () => {
    // "gpt-5.6-luna" is not in the mocked gateway map above, so the gateway
    // half returns `{}` — exactly what OpenAI's /v1/models produces for every
    // model. Before the table, this entry was silently skipped and the total
    // was 0.
    const accumulator = new CostAccumulator();
    accumulator.addLLMCost(
      "gpt-5.6-luna" as never,
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "chat"
    );

    const { cents, unpriced } = await accumulator.settle();

    // $0.20 in + $1.20 out per 1M = $1.40 = 140 cents.
    expect(cents).toBe(140);
    expect(unpriced).toEqual([]);
  });

  it("produces a NAMED refusal for an unknown model instead of skipping it", async () => {
    const accumulator = new CostAccumulator();
    accumulator.addLLMCost(
      "no-pricing" as never,
      { inputTokens: 1000, outputTokens: 500 },
      "chat"
    );

    const { cents, unpriced } = await accumulator.settle();

    expect(cents).toBe(0);
    // The old code returned 0 here and said nothing, which is how every call in
    // the app went unbilled for 23 turns without anyone noticing.
    expect(unpriced).toHaveLength(1);
    expect(unpriced[0].modelId).toBe("no-pricing");
    expect(unpriced[0].source).toBe("chat");
    expect(unpriced[0].reason).toContain("No capability entry");
  });

  it("still bills what it can when only some entries are unpriced", async () => {
    const accumulator = new CostAccumulator();
    accumulator.addLLMCost(
      "gpt-5.6-luna" as never,
      { inputTokens: 1_000_000, outputTokens: 0 },
      "chat"
    );
    accumulator.addLLMCost(
      "no-pricing" as never,
      { inputTokens: 999 },
      "title"
    );

    const { cents, unpriced } = await accumulator.settle();

    // 20 cents from luna's input, and an explicit note that the total is an
    // undercount rather than a quiet 20.
    expect(cents).toBe(20);
    expect(unpriced).toHaveLength(1);
    expect(unpriced[0].source).toBe("title");
  });

  it("refuses to bill chat output against an embedding model", async () => {
    // text-embedding-3-small publishes no output price because it emits no
    // output tokens. Treating that null as 0 would silently undercharge; it is
    // named instead.
    const accumulator = new CostAccumulator();
    accumulator.addLLMCost(
      "text-embedding-3-small" as never,
      { inputTokens: 1000, outputTokens: 500 },
      "embed"
    );

    const { unpriced } = await accumulator.settle();

    expect(unpriced).toHaveLength(1);
    expect(unpriced[0].reason).toContain("publishes no output price");
  });
});
