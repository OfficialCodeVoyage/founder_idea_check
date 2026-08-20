import { describe, expect, it } from "vitest";
import { PROJECT_FACT_UPSERT_SET } from "@/lib/db/fact-upsert";

/**
 * A later phase corrects an earlier phase's fact through the (projectId, key)
 * upsert, which rewrites `value` IN PLACE on the same row. If the embedding
 * columns survive that rewrite, the row's vector goes on describing the OLD
 * text while `embeddingModel`/`embeddingDims` still match config — so
 * embedStaleProjectFacts's staleness query sees nothing to re-embed, and the
 * fact is then retrieved by the wrong meaning. Silently, and forever.
 *
 * Asserted against the REAL exported clause. A test that re-types the SQL only
 * proves the test agrees with itself.
 */
function clauseText(key: keyof typeof PROJECT_FACT_UPSERT_SET): string {
  // Walk the drizzle SQL template's chunks rather than rendering it, so this
  // test needs no schema import and therefore no validated environment.
  const chunks = (
    PROJECT_FACT_UPSERT_SET[key] as unknown as {
      queryChunks?: { value?: unknown }[];
    }
  ).queryChunks;
  if (!chunks) {
    throw new Error(`${key} is not a drizzle SQL template`);
  }
  return chunks
    .map((chunk) => (Array.isArray(chunk?.value) ? chunk.value.join("") : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const EMBEDDING_COLUMNS = [
  "embedding",
  "embeddingModel",
  "embeddingDims",
] as const;

describe("ProjectFact upsert invalidates a vector whose text changed", () => {
  it.each(
    EMBEDDING_COLUMNS
  )("resets %s only when the value actually differs", (column) => {
    const text = clauseText(column);
    // IS DISTINCT FROM, not <>: a NULL on either side must compare as
    // different rather than as unknown.
    expect(text).toContain('IS DISTINCT FROM excluded."value"');
    expect(text).toContain("THEN NULL");
    // The ELSE branch is what stops an unchanged fact from being re-embedded
    // on every extraction pass, which would be correct but costly.
    expect(text).toContain("ELSE");
  });

  it("guards all three embedding columns, because the CHECK needs them together", () => {
    // ProjectFact_embedding_labelled asserts
    //   (embedding IS NULL) = (embeddingModel IS NULL)
    //   AND (embedding IS NULL) = (embeddingDims IS NULL)
    // so resetting only `embedding` would fail the write outright.
    for (const column of EMBEDDING_COLUMNS) {
      expect(PROJECT_FACT_UPSERT_SET[column]).toBeDefined();
    }
  });

  it("still writes the corrected value and its provenance", () => {
    for (const key of [
      "value",
      "confidence",
      "phaseKey",
      "sourceMessageId",
      "extractedAt",
    ] as const) {
      expect(clauseText(key)).toContain("excluded.");
    }
  });
});
