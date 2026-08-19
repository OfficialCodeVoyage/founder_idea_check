import { describe, expect, it } from "vitest";
import {
  anthropicThinkingOptions,
  LEGACY_THINKING_BUDGET_TOKENS,
  parseClaudeVersion,
  supportsAdaptiveThinking,
} from "./anthropic-thinking";
import {
  ANTHROPIC_MODEL_IDS,
  ANTHROPIC_MODELS,
} from "./gateways/anthropic-models";

/**
 * The ids the catalog actually ships, split by which thinking shape Anthropic
 * accepts for them. Written out by hand rather than derived, so a wrong parse
 * fails the test instead of agreeing with itself.
 */
const ADAPTIVE = [
  "claude-opus-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
];
const BUDGETED = [
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
];

describe("parseClaudeVersion", () => {
  it("reads major and minor from a modern id", () => {
    expect(parseClaudeVersion("claude-opus-4-8")).toEqual({
      major: 4,
      minor: 8,
    });
  });

  it("treats a missing minor as .0", () => {
    expect(parseClaudeVersion("claude-opus-5")).toEqual({ major: 5, minor: 0 });
    expect(parseClaudeVersion("claude-fable-5")).toEqual({
      major: 5,
      minor: 0,
    });
  });

  it("ignores the date suffix on a pinned snapshot", () => {
    expect(parseClaudeVersion("claude-haiku-4-5-20251001")).toEqual({
      major: 4,
      minor: 5,
    });
  });

  it("strips a gateway's provider prefix", () => {
    expect(parseClaudeVersion("anthropic/claude-opus-4-5")).toEqual({
      major: 4,
      minor: 5,
    });
  });

  it("reads the legacy version-first id shape", () => {
    expect(parseClaudeVersion("claude-3-5-sonnet-20241022")).toEqual({
      major: 3,
      minor: 5,
    });
    expect(parseClaudeVersion("claude-3-haiku-20240307")).toEqual({
      major: 3,
      minor: 0,
    });
  });

  it("returns null for something that is not a Claude id", () => {
    expect(parseClaudeVersion("gpt-5-mini")).toBeNull();
    expect(parseClaudeVersion("")).toBeNull();
  });
});

describe("supportsAdaptiveThinking", () => {
  it("is true from 4.6 upward", () => {
    expect(supportsAdaptiveThinking("claude-opus-4-6")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-4-7")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-5")).toBe(true);
  });

  it("is false below 4.6 — the models that need budgetTokens", () => {
    expect(supportsAdaptiveThinking("claude-opus-4-5")).toBe(false);
    expect(supportsAdaptiveThinking("claude-sonnet-4-5")).toBe(false);
    expect(supportsAdaptiveThinking("claude-haiku-4-5")).toBe(false);
    expect(supportsAdaptiveThinking("claude-opus-4-1")).toBe(false);
    expect(supportsAdaptiveThinking("claude-sonnet-4-0")).toBe(false);
    expect(supportsAdaptiveThinking("claude-3-5-sonnet-20241022")).toBe(false);
  });

  it("defaults an unrecognised id to adaptive, which is today's behaviour", () => {
    expect(supportsAdaptiveThinking("claude-something-new")).toBe(true);
    expect(supportsAdaptiveThinking("some-future-model")).toBe(true);
  });
});

describe("anthropicThinkingOptions", () => {
  it("asks for summaries on the adaptive shape", () => {
    for (const id of ADAPTIVE) {
      expect(anthropicThinkingOptions(id)).toEqual({
        type: "adaptive",
        display: "summarized",
      });
    }
  });

  it("sends budgetTokens — and no `display` — on the legacy shape", () => {
    for (const id of BUDGETED) {
      const options = anthropicThinkingOptions(id);
      expect(options).toEqual({
        type: "enabled",
        budgetTokens: LEGACY_THINKING_BUDGET_TOKENS,
      });
      // `display` exists only on the adaptive shape; the budgeted one rejects
      // unknown fields.
      expect(options).not.toHaveProperty("display");
    }
  });

  it("never sends budgetTokens to a model that 400s on it", () => {
    for (const id of ADAPTIVE) {
      expect(anthropicThinkingOptions(id)).not.toHaveProperty("budgetTokens");
    }
  });

  it("covers every id in the shipped catalog", () => {
    // If a model is added to ANTHROPIC_MODEL_IDS without being classified here,
    // this fails rather than silently 400ing in production.
    expect([...ANTHROPIC_MODEL_IDS].sort()).toEqual(
      [...ADAPTIVE, ...BUDGETED].sort()
    );
  });

  it("keeps every legacy budget inside that model's max_tokens", () => {
    // Anthropic requires budgetTokens < max_tokens.
    for (const model of ANTHROPIC_MODELS) {
      const options = anthropicThinkingOptions(model.id);
      if (options.type === "enabled") {
        expect(options.budgetTokens).toBeLessThan(model.max_tokens);
      }
    }
  });
});
