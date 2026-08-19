import { describe, expect, it } from "vitest";
import { approxTokenCount, budgetTranscript } from "./context";
import { renderTranscript } from "./gate";
import type { TranscriptTurn } from "./types";

function turn(role: "user" | "assistant", text: string): TranscriptTurn {
  return { role, text };
}

const TURNS: TranscriptTurn[] = [
  turn("user", "oldest — we sell to dentists"),
  turn("assistant", "who exactly?"),
  turn("user", "practice managers at 3-chair clinics"),
  turn("assistant", "what do they do today?"),
  turn("user", "newest — a shared spreadsheet"),
];

/** A tokenizer that is NOT additive across turns, like a real one. */
const clumpingCounter = (text: string) =>
  Math.ceil(text.replace(/\s+/g, "").length / 3);

describe("budgetTranscript", () => {
  it("returns everything when the budget is generous", () => {
    const r = budgetTranscript(TURNS, 10_000);
    expect(r.turns).toEqual(TURNS);
    expect(r.omittedTurns).toBe(0);
  });

  it("handles an empty transcript", () => {
    expect(budgetTranscript([], 100)).toEqual({ turns: [], omittedTurns: 0 });
  });

  it("keeps the NEWEST turns and reports how many were dropped", () => {
    const full = approxTokenCount(renderTranscript(TURNS));
    const r = budgetTranscript(TURNS, Math.floor(full / 2));
    expect(r.turns.length).toBeGreaterThan(0);
    expect(r.turns.length).toBeLessThan(TURNS.length);
    expect(r.turns.at(-1)).toEqual(TURNS.at(-1));
    expect(r.omittedTurns).toBe(TURNS.length - r.turns.length);
  });

  it("preserves chronological order even though it fills newest-first", () => {
    const full = approxTokenCount(renderTranscript(TURNS));
    const r = budgetTranscript(TURNS, Math.floor(full * 0.7));
    const original = TURNS.map((t) => t.text);
    const kept = r.turns.map((t) => t.text);
    expect(kept).toEqual(original.slice(original.length - kept.length));
  });

  it("never exceeds the budget, for every budget from 0 to full", () => {
    const full = approxTokenCount(renderTranscript(TURNS));
    for (let budget = 0; budget <= full + 5; budget++) {
      const r = budgetTranscript(TURNS, budget);
      if (r.turns.length > 0) {
        expect(approxTokenCount(renderTranscript(r.turns))).toBeLessThanOrEqual(
          budget
        );
      }
    }
  });

  it("never exceeds the budget under a non-additive counter either", () => {
    const full = clumpingCounter(renderTranscript(TURNS));
    for (let budget = 0; budget <= full; budget += 3) {
      const r = budgetTranscript(TURNS, budget, clumpingCounter);
      if (r.turns.length > 0) {
        expect(clumpingCounter(renderTranscript(r.turns))).toBeLessThanOrEqual(
          budget
        );
      }
    }
  });

  it("never splits a turn — every kept turn is byte-identical to its source", () => {
    const full = approxTokenCount(renderTranscript(TURNS));
    for (let budget = 0; budget <= full; budget++) {
      for (const kept of budgetTranscript(TURNS, budget).turns) {
        expect(TURNS).toContainEqual(kept);
      }
    }
  });

  it("emits nothing rather than overspending when even one turn will not fit", () => {
    const r = budgetTranscript(TURNS, 1);
    expect(r.turns).toEqual([]);
    expect(r.omittedTurns).toBe(TURNS.length);
  });

  it("is deterministic", () => {
    const a = budgetTranscript(TURNS, 40);
    const b = budgetTranscript(TURNS, 40);
    expect(a).toEqual(b);
  });

  it("stops at the first turn that does not fit rather than skipping it", () => {
    // A huge turn in the middle must not be leapfrogged: skipping it would hand
    // the judge a conversation that never happened.
    const withGiant: TranscriptTurn[] = [
      turn("user", "old and small"),
      turn("assistant", "X".repeat(4000)),
      turn("user", "new and small"),
    ];
    const r = budgetTranscript(withGiant, 40);
    expect(r.turns).toEqual([turn("user", "new and small")]);
    expect(r.omittedTurns).toBe(2);
  });
});
