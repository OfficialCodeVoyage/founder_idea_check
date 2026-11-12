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

// GUARD: the chat model's usage is recorded per step, and a step an abort cuts
// off is estimated, so a stopped or deadline-cut turn is never free. Before
// this, "main-chat" usage came only from the stream's final `finish` part,
// which `streamText` does not write on abort or when a later step fails.
describe("createMainChatUsageMeter", () => {
  const usage = (inputTokens?: number, outputTokens?: number) => ({
    inputTokens,
    outputTokens,
    totalTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  });
  const finishStep = (
    inputTokens?: number,
    outputTokens?: number,
    finishReason = "stop"
  ) => ({
    type: "finish-step",
    finishReason,
    usage: usage(inputTokens, outputTokens),
  });

  async function meter(
    parts: Record<string, unknown>[],
    { end = "close" }: { end?: "close" | "error" } = {}
  ) {
    const { createMainChatUsageMeter, MAIN_CHAT_CUT_STEP_SOURCE } =
      await import("./main-chat-usage");
    const accumulator = new CostAccumulator();
    // 19,320 characters at the test's 4 per token, plus two images: 5000.
    const getPromptFloor = vi.fn(() => ({
      texts: ["x".repeat(16_000), "y".repeat(3320)],
      attachmentTokens: 170,
    }));
    const transform = createMainChatUsageMeter({
      costAccumulator: accumulator,
      modelId: "test-model" as never,
      countTokens: (text) => Math.ceil(text.length / 4),
      getPromptFloor,
    })();
    const passed: unknown[] = [];
    const reading = (async () => {
      const reader = transform.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        passed.push(value);
      }
    })();
    const writer = transform.writable.getWriter();
    for (const part of parts) {
      await writer.write(part as never);
    }
    if (end === "error") {
      // What `pipeThrough` does when the provider's connection dies: the
      // upstream errors, so the transform's writable side is aborted.
      await writer.abort(new TypeError("terminated"));
      await reading.catch(() => undefined);
    } else {
      await writer.close();
      await reading;
    }
    const entries = accumulator
      .getEntries()
      .map((entry) =>
        entry.type === "llm"
          ? [entry.source, entry.usage.inputTokens, entry.usage.outputTokens]
          : null
      );
    return {
      entries,
      passed,
      getPromptFloor,
      cutSource: MAIN_CHAT_CUT_STEP_SOURCE,
    };
  }

  it("records each completed step once, from its finish-step", async () => {
    const { entries, passed } = await meter([
      { type: "start-step" },
      { type: "tool-input-delta", id: "c1", delta: "{}" },
      finishStep(40_000, 3000, "tool-calls"),
      { type: "start-step" },
      { type: "text-delta", id: "t", text: "hello" },
      finishStep(43_000, 2000),
      { type: "finish", totalUsage: usage(83_000, 5000) },
    ]);
    expect(entries).toEqual([
      ["main-chat", 40_000, 3000],
      ["main-chat", 43_000, 2000],
    ]);
    // Every part still reaches the rest of the pipeline.
    expect(passed).toHaveLength(7);
  });

  it("estimates a step cut off in step 2 from the step before it", async () => {
    const { entries, getPromptFloor, cutSource } = await meter([
      { type: "start-step" },
      finishStep(40_000, 3000, "tool-calls"),
      { type: "start-step" },
      { type: "text-delta", id: "t", text: "x".repeat(400) },
      { type: "reasoning-delta", id: "r", text: "y".repeat(40) },
      { type: "abort" },
    ]);
    expect(entries).toEqual([
      ["main-chat", 40_000, 3000],
      [cutSource, 43_000, 110],
    ]);
    expect(getPromptFloor).not.toHaveBeenCalled();
  });

  it("estimates a step cut off in step 1 from the counted prompt", async () => {
    const { entries, cutSource } = await meter([
      { type: "start-step" },
      { type: "text-delta", id: "t", text: "x".repeat(40) },
      { type: "abort" },
    ]);
    expect(entries).toEqual([[cutSource, 5000, 10]]);
  });

  it("charges nothing for a step the provider never started", async () => {
    const { entries } = await meter([
      { type: "start-step" },
      finishStep(40_000, 3000, "tool-calls"),
      { type: "abort" },
    ]);
    expect(entries).toEqual([["main-chat", 40_000, 3000]]);
  });

  // GUARD: a provider connection that dies mid-step errors the stream with no
  // abort, error or finish-step part; the open step was still uncharged.
  it("estimates the open step when the stream errors without an abort part", async () => {
    const second = await meter(
      [
        { type: "start-step" },
        finishStep(40_000, 3000, "tool-calls"),
        { type: "start-step" },
        { type: "text-delta", id: "t", text: "x".repeat(400) },
      ],
      { end: "error" }
    );
    expect(second.entries).toEqual([
      ["main-chat", 40_000, 3000],
      [second.cutSource, 43_000, 100],
    ]);

    const first = await meter(
      [
        { type: "start-step" },
        { type: "text-delta", id: "t", text: "x".repeat(40) },
      ],
      { end: "error" }
    );
    expect(first.entries).toEqual([[first.cutSource, 5000, 10]]);

    // Exactly once: a step already recorded, or already estimated on abort,
    // is not estimated again when the stream then errors.
    const recorded = await meter(
      [{ type: "start-step" }, finishStep(40_000, 3000, "tool-calls")],
      { end: "error" }
    );
    expect(recorded.entries).toEqual([["main-chat", 40_000, 3000]]);
    const aborted = await meter(
      [
        { type: "start-step" },
        { type: "text-delta", id: "t", text: "x".repeat(40) },
        { type: "abort" },
      ],
      { end: "error" }
    );
    expect(aborted.entries).toEqual([[aborted.cutSource, 5000, 10]]);
  });

  it("charges a failed step's usage when the provider reported it, and skips it when not", async () => {
    const reported = await meter([
      { type: "start-step" },
      finishStep(40_000, 3000, "tool-calls"),
      { type: "start-step" },
      { type: "error", error: "response.failed" },
      finishStep(43_000, 40, "error"),
    ]);
    expect(reported.entries).toEqual([
      ["main-chat", 40_000, 3000],
      ["main-chat", 43_000, 40],
    ]);

    const unreported = await meter([
      { type: "start-step" },
      finishStep(40_000, 3000, "tool-calls"),
      { type: "start-step" },
      { type: "error", error: "provider error" },
      finishStep(undefined, undefined, "error"),
    ]);
    expect(unreported.entries).toEqual([["main-chat", 40_000, 3000]]);
  });
});

// GUARD: step 1's estimate counts the prompt's real content as a floor. It
// used to add a flat 765 tokens per non-text part (overcounting small tool
// calls), and then briefly left tool results, images and files out
// altogether (undercounting a prompt that carries big ones).
describe("promptFloor", () => {
  it("counts tool calls and results as their text, images and files at a minimum", async () => {
    const { promptFloor, IMAGE_FLOOR_TOKENS } = await import(
      "./main-chat-usage"
    );
    const report = "r".repeat(30_000);
    const floor = promptFloor("system prompt", [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", image: new URL("https://example.com/a.png") },
          { type: "file", mediaType: "image/png", data: new Uint8Array(9) },
          {
            type: "file",
            mediaType: "text/markdown",
            data: new TextEncoder().encode("# notes"),
          },
          {
            type: "file",
            mediaType: "application/pdf",
            data: new Uint8Array(9),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "deepResearch",
            input: { topic: "dog walking" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "deepResearch",
            output: { type: "json", value: { report } },
          },
        ],
      },
    ]);
    expect(floor.texts).toEqual([
      "system prompt",
      "look at this",
      "# notes",
      '{"topic":"dog walking"}',
      JSON.stringify({ report }),
    ]);
    // Two images and one PDF, each at the per-attachment minimum.
    expect(floor.attachmentTokens).toBe(3 * IMAGE_FLOOR_TOKENS);
  });
});
