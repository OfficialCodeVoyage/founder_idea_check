/**
 * The PURE half of the embedding layer: constants, the canonical text form of
 * a fact, and cosine similarity. No `ai`, no `@ai-sdk/*`, no network, no key.
 *
 * It is split from provider.ts because lib/phases/context.ts imports from here
 * and context.ts is a pure module by contract — importing the provider would
 * drag the whole AI SDK into a file that has to stay runnable under vitest
 * with no API key and no network.
 */

/**
 * The width baked into `ProjectFact.embedding`. Changing this is a MIGRATION
 * plus a full re-embed, not a config change — the column type carries it.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * pgvector will not build an hnsw or ivfflat index above this width. Verified
 * live against pgvector 0.8.6:
 *   ERROR: column cannot have more than 2000 dimensions for hnsw index
 * This is why text-embedding-3-large's native 3072 is not an option: the
 * column would accept it and every query would silently degrade to a
 * sequential scan — fine on a dev database, ruinous in production.
 */
export const PGVECTOR_MAX_INDEXED_DIMENSIONS = 2000;

/**
 * $0.02/1M tokens. A 200-fact project is ~10k tokens, so re-embedding an
 * entire project costs about $0.0002. Embeddings are not a budget line.
 *
 * The upgrade path, if retrieval quality proves insufficient, is
 * `text-embedding-3-large` with `dimensions: 1536` — better vectors at the
 * SAME column width, so it is a re-embed and not a migration.
 */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export const EMBEDDING_DIMENSION_MISMATCH =
  "embedding provider dimension does not match the ProjectFact.embedding column width";

/**
 * A vector space is only coherent if everything in it came from one model at
 * one width. Mixing widths does not throw at the database — pgvector rejects
 * that — but mixing MODELS at the same width produces cosine distances that
 * are arithmetically valid and semantically meaningless. Both failures are
 * caught here and at the ProjectFact_embedding_labelled check constraint.
 */
export function assertIndexableDimensions(dimensions: number): void {
  if (dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `${EMBEDDING_DIMENSION_MISMATCH}: provider gives ${dimensions}, column is ${EMBEDDING_DIMENSIONS}`
    );
  }
  if (dimensions > PGVECTOR_MAX_INDEXED_DIMENSIONS) {
    throw new Error(
      `${dimensions} dimensions cannot be indexed by pgvector (max ${PGVECTOR_MAX_INDEXED_DIMENSIONS})`
    );
  }
}

/**
 * The canonical text embedded for a fact. Includes the KEY, not just the
 * value: "willingness_to_pay" carries meaning the value alone often does not
 * ("£380-420 a month" is a number until the key says what it is for).
 *
 * Exported and pure so the write path and the query path cannot drift —
 * embedding a fact one way and querying another is the classic silent
 * retrieval bug, and it presents as "retrieval is a bit off", never as an
 * error.
 */
export function factEmbeddingText(fact: {
  key: string;
  value: string;
}): string {
  return `${fact.key.replaceAll("_", " ")}: ${fact.value}`;
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 — not NaN, not a throw — for a
 * zero-magnitude vector, so one degenerate embedding cannot poison an entire
 * ranking with NaN comparisons (NaN sorts unpredictably and would silently
 * scramble the order rather than fail).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Cosine similarity mapped onto the 0-100 scale every other scoring component
 * uses, and ROUNDED TO AN INTEGER on purpose: context.ts scores in integers so
 * that two runs on two machines produce the same ordering bit for bit.
 *
 * The map is (1 + cos) / 2, not max(0, cos). Clamping negatives to 0 would
 * make "actively unrelated" and "orthogonal" score identically, which loses
 * exactly the signal that pushes an irrelevant fact out of a tight budget.
 */
export function similarityToScore(similarity: number): number {
  const clamped = Math.max(-1, Math.min(1, similarity));
  return Math.round(((clamped + 1) / 2) * 100);
}
