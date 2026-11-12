import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { followupContext } from "./followup-suggestions";

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
