import { describe, expect, it } from "vitest";
import {
  assertIndexableDimensions,
  cosineSimilarity,
  EMBEDDING_DIMENSION_MISMATCH,
  EMBEDDING_DIMENSIONS,
  factEmbeddingText,
  PGVECTOR_MAX_INDEXED_DIMENSIONS,
  similarityToScore,
} from "./text";

describe("cosineSimilarity", () => {
  it("is 1 for identical directions and -1 for opposite ones", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [-3, 0])).toBeCloseTo(-1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    // A single NaN would sort unpredictably and silently scramble an entire
    // ranking rather than failing — worse than being wrong loudly.
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(Number.isNaN(cosineSimilarity([0, 0], [1, 1]))).toBe(false);
  });

  it("returns 0 for mismatched or empty inputs instead of throwing", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("similarityToScore", () => {
  it("maps [-1, 1] onto [0, 100] with orthogonal at the midpoint", () => {
    expect(similarityToScore(1)).toBe(100);
    expect(similarityToScore(0)).toBe(50);
    expect(similarityToScore(-1)).toBe(0);
  });

  it("keeps 'actively unrelated' distinguishable from 'orthogonal'", () => {
    // Clamping negatives to 0 would collapse these two, losing exactly the
    // signal that evicts an irrelevant fact from a tight token budget.
    expect(similarityToScore(-0.8)).toBeLessThan(similarityToScore(0));
  });

  it("clamps out-of-range input rather than producing an out-of-range score", () => {
    expect(similarityToScore(4)).toBe(100);
    expect(similarityToScore(-4)).toBe(0);
  });

  it("always returns an integer, so ordering is identical across machines", () => {
    for (const s of [-1, -0.37, 0, 0.111, 0.5, 1]) {
      expect(Number.isInteger(similarityToScore(s))).toBe(true);
    }
  });
});

describe("factEmbeddingText", () => {
  it("includes the key, because the value alone is often ambiguous", () => {
    const text = factEmbeddingText({
      key: "willingness_to_pay",
      value: "£380-420 a month",
    });

    expect(text).toContain("willingness to pay");
    expect(text).toContain("£380-420 a month");
  });

  it("is stable — the write path and the query path must not drift", () => {
    const fact = { key: "target_user", value: "Dental practice manager" };

    expect(factEmbeddingText(fact)).toBe(factEmbeddingText({ ...fact }));
    expect(factEmbeddingText(fact)).toBe(
      "target user: Dental practice manager"
    );
  });
});

describe("assertIndexableDimensions", () => {
  it("accepts exactly the column width", () => {
    expect(() => assertIndexableDimensions(EMBEDDING_DIMENSIONS)).not.toThrow();
  });

  it("rejects any other width, because the column type carries it", () => {
    expect(() => assertIndexableDimensions(768)).toThrow(
      EMBEDDING_DIMENSION_MISMATCH
    );
    expect(() => assertIndexableDimensions(3072)).toThrow(
      EMBEDDING_DIMENSION_MISMATCH
    );
  });

  it("keeps the column width under pgvector's index ceiling", () => {
    // Verified live against pgvector 0.8.6:
    //   ERROR: column cannot have more than 2000 dimensions for hnsw index
    // Above the ceiling the column still WORKS and every query silently
    // degrades to a sequential scan, which is why this is asserted and not
    // left as a comment.
    expect(EMBEDDING_DIMENSIONS).toBeLessThanOrEqual(
      PGVECTOR_MAX_INDEXED_DIMENSIONS
    );
  });
});
