import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  followupContext,
  shouldSuggestFollowups,
} from "./followup-suggestions";

// GUARD: an aborted turn (Stop, or the deadline) whose earlier step had
// completed still got follow-up suggestions, a paid call.
describe("shouldSuggestFollowups", () => {
  it("skips an aborted turn and keeps a normal one", () => {
    const turn = { enabled: true, turnAborted: false, turnRefused: false };
    expect(shouldSuggestFollowups({ ...turn, turnAborted: true })).toBe(false);
    expect(shouldSuggestFollowups(turn)).toBe(true);
    expect(shouldSuggestFollowups({ ...turn, enabled: false })).toBe(false);
    expect(shouldSuggestFollowups({ ...turn, turnRefused: true })).toBe(false);
  });
});

/**
 * GUARD for the 400 "No tool call found for function call output": the
 * suggestion request must never carry a tool result, with or without its call.
 */
describe("followupContext", () => {
  const toolTurn: ModelMessage[] = [
    { role: "user", content: "Run deep research on this." },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "deepResearch",
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "deepResearch",
          output: { type: "json", value: { format: "report" } },
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "The report is above." }],
    },
  ];

  it("keeps no tool message and no tool part after a tool-call turn", () => {
    const context = followupContext(toolTurn);

    expect(context.some((message) => message.role === "tool")).toBe(false);
    for (const message of context) {
      expect(typeof message.content).toBe("string");
    }
  });

  it("keeps the last two turns that carry text", () => {
    expect(followupContext(toolTurn)).toEqual([
      { role: "user", content: "Run deep research on this." },
      { role: "assistant", content: "The report is above." },
    ]);
  });
});
