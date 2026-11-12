import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { checkResearchRequest } from "./research-request";

/**
 * `deepResearch` was called with `tool_input = {}` — 2 bytes — and the failure
 * surfaced to the founder as "Deep research failed with error: Invalid prompt:
 * messages must not be empty". That is an AI-SDK validation string, leaked from
 * three layers down, and there is nothing a founder can do with it.
 *
 * The tool's `inputSchema` really is `z.object({})`: its subject is the
 * conversation, passed in as `contextForLLM`. `{}` is therefore normal, and the
 * 2026-08-21 failure itself was a zero token budget (see research-request.ts).
 * What is checked HERE is the other way to send nothing, a conversation with no
 * text, caught at the call site before `clarifyWithUser` hands an empty prompt
 * to `generateText`.
 */

function user(text: string): ModelMessage {
  return { role: "user", content: text };
}

describe("checkResearchRequest", () => {
  it("accepts a conversation with something in it", () => {
    expect(checkResearchRequest([user("Research the market for X")]).ok).toBe(
      true
    );
  });

  it("accepts structured content parts", () => {
    const message: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: "Research the market for X" }],
    };

    expect(checkResearchRequest([message]).ok).toBe(true);
  });

  it("REFUSES an empty message list without leaking the SDK's wording", () => {
    const check = checkResearchRequest([]);

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.message).not.toContain("Invalid prompt");
      expect(check.message).not.toContain("messages must not be empty");
      // It must say the search did not happen, or the model will summarise the
      // failure as "I found no evidence".
      expect(check.message).toContain("Nothing was searched");
    }
  });

  it("REFUSES a conversation that carries no text at all", () => {
    // A list of tool-result parts and nothing else still builds no query, and
    // it reaches `generateText` as a prompt with no content.
    const message: ModelMessage = { role: "user", content: [] };

    expect(checkResearchRequest([message]).ok).toBe(false);
  });

  it("REFUSES a conversation that is only whitespace", () => {
    expect(checkResearchRequest([user("   \n  ")]).ok).toBe(false);
  });
});
