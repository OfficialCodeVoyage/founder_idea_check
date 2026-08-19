#!/usr/bin/env bun
/**
 * Embeds (or re-embeds) the stored facts of one project, or of every project.
 *
 * The normal path is automatic — runtime.ts backfills after each turn — so this
 * exists for the two cases that path does not cover:
 *   1. facts written before embeddings existed, or before a model change;
 *   2. proving the pgvector column, the HNSW index and the provider actually
 *      work against a real database rather than a mock.
 *
 * Incremental: it only touches rows whose vector is missing or whose model or
 * width differs from the configured provider. Running it twice is a no-op.
 *
 * Run:  cd apps/chat && bun scripts/embed-facts.ts [projectId]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvConfig } from "dotenv";

const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnvConfig({ path: path.join(HERE, "../../../.env.local") });

const { drizzle } = await import("drizzle-orm/postgres-js");
const postgres = (await import("postgres")).default;
const { sql: rawSql } = await import("drizzle-orm");
const { getEmbeddingProvider } = await import("../lib/embeddings/provider");
const { factEmbeddingText } = await import("../lib/embeddings/text");

const provider = getEmbeddingProvider();
if (!provider) {
  process.stderr.write(
    "No OPENAI_API_KEY — nothing to do. Retrieval falls back to the keyword selector, which needs no key.\n"
  );
  process.exit(0);
}

const client = postgres(process.env.DATABASE_URL as string, { max: 1 });
const db = drizzle(client);

const projectId = process.argv[2];
const where = projectId
  ? rawSql`"projectId" = ${projectId} AND (embedding IS NULL OR "embeddingModel" IS DISTINCT FROM ${provider.model} OR "embeddingDims" IS DISTINCT FROM ${provider.dimensions})`
  : rawSql`embedding IS NULL OR "embeddingModel" IS DISTINCT FROM ${provider.model} OR "embeddingDims" IS DISTINCT FROM ${provider.dimensions}`;

const stale = (await db.execute(
  rawSql`SELECT id, key, value FROM "ProjectFact" WHERE ${where}`
)) as unknown as { id: string; key: string; value: string }[];

process.stdout.write(
  `${stale.length} fact(s) need embedding with ${provider.model} @ ${provider.dimensions}d\n`
);
if (stale.length === 0) {
  await client.end();
  process.exit(0);
}

const result = await provider.embed(stale.map(factEmbeddingText));

for (const [i, row] of stale.entries()) {
  const vector = result.vectors[i];
  if (!vector) {
    continue;
  }
  await db.execute(
    rawSql`UPDATE "ProjectFact"
           SET embedding = ${JSON.stringify(vector)}::vector,
               "embeddingModel" = ${result.model},
               "embeddingDims" = ${result.dimensions},
               "embeddedAt" = now()
           WHERE id = ${row.id}`
  );
  process.stdout.write(`  ✓ ${row.key}\n`);
}

process.stdout.write(
  `\nembedded ${stale.length} fact(s), ${result.tokens ?? "?"} tokens billed\n`
);
await client.end();
