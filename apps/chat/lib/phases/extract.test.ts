import { describe, expect, it } from "vitest";
import { PHASE_ONE } from "./definitions";
import {
  buildExtractionPrompt,
  extractFacts,
  type FactExtractor,
  MIN_FACT_CONFIDENCE,
  reconcileFacts,
  sanitizeFacts,
} from "./extract";
import type { ExtractedFact, KnownFact } from "./types";

const ALLOWED = PHASE_ONE.factKeys;

function fact(
  key: string,
  value: string,
  confidence = 80,
  evidence = "they said so"
): ExtractedFact {
  return { key, value, confidence, evidence };
}

describe("sanitizeFacts — the vocabulary and evidence filter", () => {
  it("drops a key outside the phase vocabulary", () => {
    const kept = sanitizeFacts(
      [fact("target_user", "dog walkers"), fact("pricing_model", "$9/mo")],
      ALLOWED
    );

    expect(kept.map((f) => f.key)).toEqual(["target_user"]);
  });

  it("drops a fact with no evidence quote", () => {
    const kept = sanitizeFacts(
      [fact("target_user", "dog walkers", 90, "   ")],
      ALLOWED
    );

    expect(kept).toEqual([]);
  });

  it("drops a fact below the confidence floor", () => {
    const kept = sanitizeFacts(
      [fact("target_user", "dog walkers", MIN_FACT_CONFIDENCE - 1)],
      ALLOWED
    );

    expect(kept).toEqual([]);
  });

  it("keeps a fact exactly at the confidence floor", () => {
    const kept = sanitizeFacts(
      [fact("target_user", "dog walkers", MIN_FACT_CONFIDENCE)],
      ALLOWED
    );

    expect(kept).toHaveLength(1);
  });

  it("dedupes a repeated key, keeping the higher confidence", () => {
    const kept = sanitizeFacts(
      [
        fact("target_user", "dog walkers", 55),
        fact("target_user", "independent dog walkers in Berlin", 90),
      ],
      ALLOWED
    );

    expect(kept).toHaveLength(1);
    expect(kept[0].value).toBe("independent dog walkers in Berlin");
    expect(kept[0].confidence).toBe(90);
  });

  it("normalizes key casing and whitespace before matching the vocabulary", () => {
    const kept = sanitizeFacts([fact("  Target_User  ", "walkers")], ALLOWED);

    expect(kept.map((f) => f.key)).toEqual(["target_user"]);
  });

  it("drops a fact whose value is only whitespace", () => {
    expect(sanitizeFacts([fact("target_user", "   ")], ALLOWED)).toEqual([]);
  });
});

describe("reconcileFacts — insert vs update vs skip", () => {
  const existing: KnownFact[] = [
    { key: "target_user", value: "dog walkers", confidence: 70 },
  ];

  it("treats an unseen key as an insert", () => {
    const result = reconcileFacts(existing, [
      fact("problem_statement", "they lose keys"),
    ]);

    expect(result.inserts.map((f) => f.key)).toEqual(["problem_statement"]);
    expect(result.updates).toEqual([]);
  });

  it("skips an identical value at identical confidence as unchanged", () => {
    const result = reconcileFacts(existing, [
      fact("target_user", "dog walkers", 70),
    ]);

    expect(result.skipped).toEqual([{ key: "target_user", why: "unchanged" }]);
    expect(result.updates).toEqual([]);
    expect(result.inserts).toEqual([]);
  });

  it("skips a contradiction that is less well evidenced", () => {
    const result = reconcileFacts(existing, [
      fact("target_user", "everyone with a dog", 40),
    ]);

    expect(result.skipped).toEqual([
      { key: "target_user", why: "lower-confidence" },
    ]);
    expect(result.updates).toEqual([]);
  });

  it("updates when the new value is at least as well evidenced", () => {
    const result = reconcileFacts(existing, [
      fact("target_user", "independent dog walkers in Berlin", 70),
    ]);

    expect(result.updates.map((f) => f.value)).toEqual([
      "independent dog walkers in Berlin",
    ]);
    expect(result.skipped).toEqual([]);
  });
});

describe("buildExtractionPrompt", () => {
  const input = {
    phase: PHASE_ONE,
    personaPrompt: "PERSONA",
    turn: [{ role: "user" as const, text: "dog walkers lose keys constantly" }],
    knownFacts: [] as KnownFact[],
  };

  it("names the permitted vocabulary so out-of-vocabulary keys are discouraged", () => {
    const { system } = buildExtractionPrompt(input);
    for (const key of PHASE_ONE.factKeys) {
      expect(system).toContain(key);
    }
  });

  it("renders an empty fact store explicitly rather than as a blank", () => {
    const { prompt } = buildExtractionPrompt(input);
    expect(prompt).toContain("(none established yet)");
    expect(prompt).toContain("dog walkers lose keys constantly");
  });
});

describe("extractFacts — never breaks the stream", () => {
  const input = {
    phase: PHASE_ONE,
    personaPrompt: "PERSONA",
    turn: [{ role: "user" as const, text: "hi" }],
    knownFacts: [] as KnownFact[],
  };

  it("returns sanitized facts from a fake extractor", async () => {
    const extract: FactExtractor = () =>
      Promise.resolve({
        facts: [
          fact("target_user", "independent dog walkers"),
          fact("pricing_model", "$9/mo"),
        ],
      });

    const facts = await extractFacts({ extract }, input);
    expect(facts.map((f) => f.key)).toEqual(["target_user"]);
  });

  it("returns [] when the extractor throws", async () => {
    const extract: FactExtractor = () =>
      Promise.reject(new Error("no api key"));
    await expect(extractFacts({ extract }, input)).resolves.toEqual([]);
  });

  it("returns [] when the extractor returns an unrecognized shape", async () => {
    const extract: FactExtractor = () => Promise.resolve({ nope: true });
    await expect(extractFacts({ extract }, input)).resolves.toEqual([]);
  });
});
