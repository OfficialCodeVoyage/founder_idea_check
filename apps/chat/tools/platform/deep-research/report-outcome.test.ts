import { describe, expect, it } from "vitest";
import { describeMissingReportDocument } from "./report-outcome";

/**
 * THE FALSE ERROR STRING.
 *
 * The 2026-08-21 transcript recorded
 *
 *     {"status":"error","error":"createTextDocument tool was not called","format":"report"}
 *
 * while, in the same turn, `createTextDocument` HAD been called with 26,731
 * characters. The sentence was simply untrue, and because it named a specific
 * tool it was believed: it sent the founder and the follow-up investigation
 * after a document-creation bug that was not the failure in front of them.
 *
 * An error message that names the wrong cause is worse than one that names
 * none. These tests fix the two branches apart.
 */

function stream(overrides: {
  finishReason?: string;
  toolCalls?: { toolName: string }[];
  text?: string;
}) {
  return {
    finishReason: Promise.resolve(overrides.finishReason ?? "stop"),
    toolCalls: Promise.resolve(overrides.toolCalls ?? []),
    text: Promise.resolve(overrides.text ?? ""),
  };
}

describe("describeMissingReportDocument", () => {
  it("says the tool WAS called when it was, and does not blame it", async () => {
    const message = await describeMissingReportDocument(
      stream({
        toolCalls: [{ toolName: "createTextDocument" }],
        finishReason: "tool-calls",
      })
    );

    expect(message).toContain("WAS called");
    expect(message).not.toContain("was not called");
    expect(message).toContain("tool-calls");
  });

  it("counts repeated attempts rather than reporting one", async () => {
    const message = await describeMissingReportDocument(
      stream({
        toolCalls: [
          { toolName: "createTextDocument" },
          { toolName: "createTextDocument" },
        ],
      })
    );

    expect(message).toContain("2 times");
  });

  it("says the model wrote prose when it never reached for the tool", async () => {
    const message = await describeMissingReportDocument(
      stream({
        text: "Here is the report you asked for…",
        finishReason: "stop",
      })
    );

    expect(message).toContain("without ever calling createTextDocument");
    expect(message).toContain("33 characters");
  });

  it("ignores calls to other tools when deciding which story to tell", async () => {
    const message = await describeMissingReportDocument(
      stream({ toolCalls: [{ toolName: "webSearch" }], text: "x" })
    );

    expect(message).toContain("without ever calling createTextDocument");
  });
});
