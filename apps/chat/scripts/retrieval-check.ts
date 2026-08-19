#!/usr/bin/env bun
/**
 * Proves semantic fact retrieval works against the REAL database — the pgvector
 * column, the HNSW index, the provider and the embedding text form, all at
 * once. Unit tests cover the ranking maths with hand-built vectors; this covers
 * the half that only fails in production: a column of the wrong width, an index
 * that is not used, or a query embedded differently from the facts.
 *
 * That last one is the dangerous bug — it never errors, it just quietly returns
 * the wrong facts, and the only symptom is the assistant seeming to forget
 * things. Hence a check whose output is the ordering itself, to be eyeballed.
 *
 * Run:  cd apps/chat && bun scripts/retrieval-check.ts [projectId]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvConfig } from "dotenv";

const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnvConfig({ path: path.join(HERE, "../../../.env.local") });

const { drizzle } = await import("drizzle-orm/postgres-js");
const postgres = (await import("postgres")).default;
const { sql } = await import("drizzle-orm");
const { getEmbeddingProvider } = await import("../lib/embeddings/provider");

const provider = getEmbeddingProvider();
if (!provider) {
  process.stderr.write("No OPENAI_API_KEY — nothing to check.\n");
  process.exit(0);
}

const client = postgres(process.env.DATABASE_URL as string, { max: 1 });
const db = drizzle(client);
const projectId = process.argv[2];

/** Phrased as a phase asks them, not as the fact keys are spelled — the point
 *  is retrieval by MEANING, so an exact keyword hit would prove nothing. */
const QUERIES = [
  "who exactly is the customer and what is their role",
  "what do people already do about this today",
  "how often does it happen and what does it cost them",
  "what evidence backs any of this up",
];

for (const q of QUERIES) {
  const [vector] = (await provider.embed([q])).vectors;
  const literal = JSON.stringify(vector);
  const rows = (await db.execute(sql`
    SELECT key,
           round((1 - (embedding <=> ${literal}::vector))::numeric, 3) AS sim
    FROM "ProjectFact"
    WHERE embedding IS NOT NULL
      ${projectId ? sql`AND "projectId" = ${projectId}` : sql``}
    ORDER BY embedding <=> ${literal}::vector
    LIMIT 3`)) as unknown as { key: string; sim: string }[];

  process.stdout.write(`\nQ: ${q}\n`);
  if (rows.length === 0) {
    process.stdout.write(
      "   (no embedded facts — run scripts/embed-facts.ts)\n"
    );
  }
  for (const r of rows) {
    process.stdout.write(`   ${r.sim}  ${r.key}\n`);
  }
}

process.stdout.write("\n");
await client.end();
