import { describe, expect, it } from "vitest";
import {
  approxTokenCount,
  countMessageTokens,
  MESSAGE_ENVELOPE_TOKENS,
  NON_TEXT_PART_TOKENS,
  selectContextWindow,
} from "./context-window";

type Msg = {
  id: string;
  role: string;
  parts: { type: string; text?: unknown }[];
};

function msg(id: string, role: string, text: string): Msg {
  return { id, role, parts: [{ type: "text", text }] };
}

function ids(messages: Msg[]): string[] {
  return messages.map((m) => m.id);
}

const CONVERSATION: Msg[] = [
  msg("m1", "user", "oldest — we sell to dentists"),
  msg("m2", "assistant", "who exactly?"),
  msg("m3", "user", "practice managers at 3-chair clinics"),
  msg("m4", "assistant", "what do they do today?"),
  msg("m5", "user", "newest — a shared spreadsheet"),
];

const cost = (messages: Msg[]) =>
  messages.reduce((total, m) => total + countMessageTokens(m), 0);

describe("countMessageTokens", () => {
  it("charges the envelope, the role and the text", () => {
    const m = msg("m", "user", "abcd");
    expect(countMessageTokens(m)).toBe(
      MESSAGE_ENVELOPE_TOKENS +
        approxTokenCount("user") +
        approxTokenCount("abcd")
    );
  });

  it("charges a non-text part the repo's image approximation", () => {
    const m: Msg = { id: "m", role: "user", parts: [{ type: "file" }] };
    expect(countMessageTokens(m)).toBe(
      MESSAGE_ENVELOPE_TOKENS + approxTokenCount("user") + NON_TEXT_PART_TOKENS
    );
  });

  it("charges nothing for reasoning parts, which never reach the model", () => {
    // filterPartsForLLM strips them; charging would shrink the window to pay
    // for text that is not sent.
    const withReasoning: Msg = {
      id: "m",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "x".repeat(4000) },
        { type: "text", text: "hello" },
      ],
    };
    expect(countMessageTokens(withReasoning)).toBe(
      countMessageTokens(msg("m", "assistant", "hello"))
    );
  });

  it("uses the injected counter", () => {
    const m = msg("m", "user", "abcd");
    expect(countMessageTokens(m, () => 100)).toBe(
      MESSAGE_ENVELOPE_TOKENS + 200
    );
  });
});

describe("selectContextWindow", () => {
  it("handles an empty history", () => {
    expect(selectContextWindow([], 100)).toEqual({
      messages: [],
      omittedMessages: 0,
    });
  });

  it("returns everything when the budget is generous", () => {
    const r = selectContextWindow(CONVERSATION, 10_000);
    expect(r.messages).toEqual(CONVERSATION);
    expect(r.omittedMessages).toBe(0);
  });

  it("keeps the NEWEST messages and reports how many were dropped", () => {
    const r = selectContextWindow(
      CONVERSATION,
      Math.floor(cost(CONVERSATION) / 2)
    );
    expect(r.messages.length).toBeGreaterThan(0);
    expect(r.messages.length).toBeLessThan(CONVERSATION.length);
    expect(r.messages.at(-1)).toEqual(CONVERSATION.at(-1));
    expect(r.omittedMessages).toBe(CONVERSATION.length - r.messages.length);
  });

  it("preserves chronological order even though it fills newest-first", () => {
    for (let budget = 0; budget <= cost(CONVERSATION) + 5; budget++) {
      const r = selectContextWindow(CONVERSATION, budget);
      expect(ids(r.messages)).toEqual(
        ids(CONVERSATION).slice(CONVERSATION.length - r.messages.length)
      );
    }
  });

  it("never exceeds the budget, for every budget from 0 to full", () => {
    for (let budget = 0; budget <= cost(CONVERSATION) + 5; budget++) {
      expect(
        cost(selectContextWindow(CONVERSATION, budget).messages)
      ).toBeLessThanOrEqual(budget);
    }
  });

  it("never splits a message — every kept message is identical to its source", () => {
    for (let budget = 0; budget <= cost(CONVERSATION); budget++) {
      for (const kept of selectContextWindow(CONVERSATION, budget).messages) {
        expect(CONVERSATION).toContainEqual(kept);
      }
    }
  });

  it("emits nothing rather than overspending when even one message will not fit", () => {
    const r = selectContextWindow(CONVERSATION, 1);
    expect(r.messages).toEqual([]);
    expect(r.omittedMessages).toBe(CONVERSATION.length);
  });

  it("stops at the first message that does not fit rather than skipping it", () => {
    const withGiant: Msg[] = [
      msg("old", "user", "old and small"),
      msg("giant", "assistant", "X".repeat(40_000)),
      msg("new", "user", "new and small"),
    ];
    const r = selectContextWindow(withGiant, 100);
    expect(ids(r.messages)).toEqual(["new"]);
    expect(r.omittedMessages).toBe(2);
  });

  it("is budgeted in tokens, not messages — the bug the .slice(-5) had", () => {
    // Five short messages and five long ones are the same COUNT and wildly
    // different cost. A message-counted window gives the model 40k tokens in
    // one conversation and 300 in another; a budget gives it the same size.
    const short = Array.from({ length: 40 }, (_, i) =>
      msg(`s${i}`, i % 2 === 0 ? "user" : "assistant", "ok")
    );
    const long = Array.from({ length: 40 }, (_, i) =>
      msg(`l${i}`, i % 2 === 0 ? "user" : "assistant", "word ".repeat(400))
    );
    const budget = 4000;

    const shortWindow = selectContextWindow(short, budget);
    const longWindow = selectContextWindow(long, budget);

    // Very different message counts…
    expect(shortWindow.messages.length).toBeGreaterThan(
      longWindow.messages.length * 4
    );
    // …but both inside the same token ceiling.
    expect(cost(shortWindow.messages)).toBeLessThanOrEqual(budget);
    expect(cost(longWindow.messages)).toBeLessThanOrEqual(budget);
  });

  it("gives the assistant far more than the five messages it used to get", () => {
    // The regression this fix exists to prevent: a realistic founder
    // conversation must not arrive at the model as five messages when the gate
    // is about to judge tens of thousands of tokens of it.
    const realistic = Array.from({ length: 120 }, (_, i) =>
      msg(
        `m${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "We interviewed another practice manager and she confirmed the rework problem again."
      )
    );
    const r = selectContextWindow(realistic, 24_000);
    expect(r.messages.length).toBe(realistic.length);
    expect(r.omittedMessages).toBe(0);
  });

  it("is deterministic", () => {
    const a = selectContextWindow(CONVERSATION, 40);
    const b = selectContextWindow(CONVERSATION, 40);
    expect(a).toEqual(b);
  });
});
