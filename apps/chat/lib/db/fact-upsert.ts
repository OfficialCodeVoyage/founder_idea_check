/**
 * The PURE half of the ProjectFact write path: the ON CONFLICT assignment list,
 * and nothing else.
 *
 * Split out of phase-queries.ts for the same reason lib/embeddings/text.ts is
 * split from provider.ts — phase-queries transitively imports `server-only`,
 * so it cannot be imported by a test at all. This clause encodes a correctness
 * rule that must be pinned by a test, so the rule lives where a test can reach
 * it. No db handle, no `server-only`, no network.
 */
import { sql } from "drizzle-orm";

/**
 * The ON CONFLICT assignment list for `upsertProjectFacts`.
 *
 * Exported so `fact-upsert.test.ts` can assert on the ACTUAL clause
 * rather than on a copy of it — a test that re-types the SQL only proves the
 * test agrees with itself.
 */
export const PROJECT_FACT_UPSERT_SET = {
  value: sql`excluded."value"`,
  confidence: sql`excluded."confidence"`,
  phaseKey: sql`excluded."phaseKey"`,
  sourceMessageId: sql`excluded."sourceMessageId"`,
  extractedAt: sql`excluded."extractedAt"`,
  updatedAt: sql`now()`,

  // INVALIDATE THE VECTOR WHEN THE TEXT CHANGES.
  //
  // This upsert rewrites `value` in place on a (projectId, key)
  // conflict, which is how a later phase corrects an earlier phase's
  // fact. Without these three lines the row keeps the embedding of the
  // OLD text: `embeddingModel` and `embeddingDims` still match config
  // and `embedding` is still non-null, so the staleness query in
  // embedStaleProjectFacts sees nothing to do. The fact then reads
  // "usage-based pricing" while its vector still means "subscription",
  // and it is retrieved — or missed — accordingly. Silently, forever.
  //
  // `IS DISTINCT FROM` rather than `<>` so that a NULL on either side
  // compares correctly. Guarding on an actual change matters: a phase
  // re-extracting an unchanged fact must NOT throw away a good vector
  // and pay to rebuild it.
  //
  // All three columns move together because
  // ProjectFact_embedding_labelled requires it — nulling `embedding`
  // alone violates the constraint and fails the write.
  embedding: sql`CASE WHEN "ProjectFact"."value" IS DISTINCT FROM excluded."value"
    THEN NULL ELSE "ProjectFact"."embedding" END`,
  embeddingModel: sql`CASE WHEN "ProjectFact"."value" IS DISTINCT FROM excluded."value"
    THEN NULL ELSE "ProjectFact"."embeddingModel" END`,
  embeddingDims: sql`CASE WHEN "ProjectFact"."value" IS DISTINCT FROM excluded."value"
    THEN NULL ELSE "ProjectFact"."embeddingDims" END`,
};
