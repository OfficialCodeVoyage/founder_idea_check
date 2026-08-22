import { describe, expect, it } from "vitest";
import {
  FOUNDER_ASSERTION_CONFIDENCE,
  type FounderFactWrite,
  MAX_ASSERTED_FACT_VALUE,
  planFactAssertion,
} from "@/lib/db/fact-assertion";
import { MIN_FACT_CONFIDENCE } from "@/lib/phases/extract";

const PHASE = {
  key: "problem-validation",
  factKeys: ["problem_statement", "target_user", "interview_count"],
} as const;

function plan(key: unknown, value: unknown) {
  return planFactAssertion({ phase: PHASE, key, value });
}

describe("the founder may assert a fact, in the phase's own vocabulary", () => {
  it("accepts a permitted key and returns a write for the phase that owns it", () => {
    const result = plan(
      "interview_count",
      "  Twelve interviews, all recorded.  "
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.write.key).toBe("interview_count");
    expect(result.write.phaseKey).toBe("problem-validation");
    // Trimmed, because trailing whitespace in the ledger reaches the judge's
    // prompt and the export verbatim.
    expect(result.write.value).toBe("Twelve interviews, all recorded.");
  });

  it("normalizes the key the way sanitizeFacts does, so the two paths agree", () => {
    const result = plan("  Interview_Count  ", "Twelve.");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.write.key).toBe("interview_count");
    }
  });

  it("refuses a key this phase's extractor could never write", () => {
    const result = plan("pricing_model", "Usage based.");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("key-not-permitted");
    // The refusal names the key, the way every other refusal in this codebase
    // names the specific thing rather than saying "invalid input".
    expect(result.detail).toContain("pricing_model");
  });

  it("refuses a key that is not a fact key at all", () => {
    for (const key of ["", "  ", "9lives", "a", "has-a-dash", 42, null]) {
      const result = plan(key, "Something.");
      expect(result.ok, `key ${String(key)} must be refused`).toBe(false);
    }
  });

  it("refuses a blank value rather than storing an empty fact", () => {
    const result = plan("interview_count", "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("value-blank");
    }
  });

  it("refuses a value longer than the column's agreed limit", () => {
    const result = plan(
      "interview_count",
      "x".repeat(MAX_ASSERTED_FACT_VALUE + 1)
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("value-too-long");
    }
  });

  it("refuses a non-string value instead of coercing one", () => {
    for (const value of [12, null, undefined, { text: "hi" }]) {
      const result = plan("interview_count", value);
      expect(result.ok, `value ${String(value)} must be refused`).toBe(false);
    }
  });
});

/**
 * THE NON-NEGOTIABLE, PINNED.
 *
 * A founder who could type both the evidence AND its confidence could walk
 * themselves through their own gate, which inverts the entire product. The
 * founder may ASSERT; the system decides what that assertion is worth.
 */
describe("a founder-supplied confidence cannot reach the database", () => {
  it("ignores a confidence sitting on the input object", () => {
    const result = planFactAssertion({
      phase: PHASE,
      key: "interview_count",
      value: "Twelve interviews.",
      // Extra properties are what an over-permissive JSON body looks like on
      // the way in. The planner reads `key` and `value` and nothing else.
      ...{ confidence: 100 },
    } as Parameters<typeof planFactAssertion>[0]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.write.confidence).toBe(FOUNDER_ASSERTION_CONFIDENCE);
    }
  });

  it("enters the ledger at the extractor's own noise floor and no higher", () => {
    // MIN_FACT_CONFIDENCE is the score below which the extractor throws a fact
    // away as noise. A founder assertion enters at exactly that floor: the
    // weakest standing anything in this ledger is allowed to have, and below
    // the 50 an extracted fact defaults to, so an assertion can never outrank
    // an extraction of the same claim.
    expect(FOUNDER_ASSERTION_CONFIDENCE).toBe(MIN_FACT_CONFIDENCE);
    expect(FOUNDER_ASSERTION_CONFIDENCE).toBeLessThan(50);
  });

  it("gives every accepted assertion the identical confidence", () => {
    const values = [
      "One interview.",
      "Fifty interviews, all recorded on video.",
    ];
    const scores = values.map((value) => {
      const result = plan("interview_count", value);
      return result.ok ? result.write.confidence : -1;
    });
    // Nothing about what the founder types moves the number. Not its length,
    // not its emphasis, not a number they put in it.
    expect(new Set(scores)).toEqual(new Set([FOUNDER_ASSERTION_CONFIDENCE]));
  });

  it("carries NO write payload on a refusal, so there is no confidence to read", () => {
    const result = plan("pricing_model", "Usage based.");
    // The house rule: the unknown arm carries no readable value. A refused
    // assertion has no key, no phase and no confidence — not a zero one.
    expect("write" in result).toBe(false);
  });

  it("cannot be handed a confidence through the write payload's type", () => {
    // COMPILE-TIME PROOF, checked by `tsc --noEmit`, not by vitest. The write
    // payload is branded, so the only way to produce one is planFactAssertion.
    // A hand-built object — which is what "the client sent a confidence" would
    // have to become — is not assignable to it. Delete the brand and this line
    // stops erroring, which is the point of @ts-expect-error being here.
    // @ts-expect-error a FounderFactWrite cannot be constructed by hand
    const forged: FounderFactWrite = {
      key: "interview_count",
      phaseKey: "problem-validation",
      value: "Twelve interviews.",
      confidence: 100,
    };
    expect(forged.confidence).toBe(100);
  });
});
