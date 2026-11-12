# ADR-0002 — Keep embeddings in the one Postgres, with pgvector

## Status
Accepted — 2026-11-12. Enforced by: `apps/chat/lib/embeddings/text.ts::assertIndexableDimensions` (pinned by
`apps/chat/lib/embeddings/text.test.ts`) and the CHECK `ProjectFact_embedding_labelled`. This records a decision taken
while the data layer was built; it is not new.

## Context
Later phases inject a token-budgeted slice of the facts established earlier, and choosing which facts is semantic
retrieval, so facts need embeddings. The workload is small: vectors are scoped to one project's facts, not to a shared
corpus. The project is meant to be run by one person on one machine, and every extra service is a reason to give up
during setup. Drizzle supports pgvector natively (the `vector` column type, `hnsw` and `ivfflat` indexes, distance
functions), so Postgres needs no new dependency. The persona simulator (OASIS) was assumed to need a graph or vector
database; it does not, because its default graph backend is in memory.

The embedding width is the constraint that decides the model. pgvector builds an HNSW or IVFFlat index only up to 2000
dimensions (the `vector` type itself allows more); Postgres reports `column cannot have more than 2000 dimensions for
hnsw index`. `text-embedding-3-large` at its native 3072 dimensions would be accepted by the column and then silently
queried by sequential scan: fine on a development database, ruinous in production. `text-embedding-3-small` is 1536
dimensions and costs $0.02 per million tokens.

## Decision
We will keep facts, history and embeddings in one Postgres. `ProjectFact.embedding` is `vector(1536)` with an HNSW
cosine index, filled with OpenAI `text-embedding-3-small` through the `OPENAI_API_KEY` the app already needs. Each row
records the model and width that produced it (`embeddingModel`, `embeddingDims`), and a CHECK keeps the three columns
together, so an unlabelled vector cannot be stored. The provider sits behind one interface
(`lib/embeddings/provider.ts`). Embeddings are optional: with no key, or when a call fails, fact selection falls back
to a keyword ranker and the fact stays visible.

## Consequences
- Postgres must ship pgvector (`pgvector/pgvector:pg17` locally). Migration `0046` creates the extension by hand,
  because drizzle-kit does not emit `CREATE EXTENSION`.
- The width is a schema decision. A different width is a migration plus a full re-embed. A stronger model at the same
  width (`text-embedding-3-large` with `dimensions: 1536`) is a re-embed only.
- Cost is not a design constraint: re-embedding a 200-fact project is about $0.0002.
- There is no key-free embedding option yet. A self-hoster without an OpenAI key gets keyword ranking. A local model
  would have to produce 1536 dimensions to drop in.
- A hosted Postgres that offers pgvector is a drop-in: nothing in the schema assumes a host.
- Correcting a fact's value invalidates its vector, so the correction clears the embedding columns and the next turn
  re-embeds the row (`docs/DATABASE.md`).
