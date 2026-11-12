-- HAND-ADDED, and it must stay hand-added.
-- drizzle-kit does not emit CREATE EXTENSION for a vector column, so on a
-- fresh database every statement below fails with 'type "vector" does not
-- exist'. This is the first migration that introduces a vector column, so this
-- is where the extension has to be created. See docs/DATABASE.md.
-- Requires an image that ships pgvector: pgvector/pgvector:pg17, not
-- postgres:17-alpine.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "ProjectFact" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "ProjectFact" ADD COLUMN "embeddingModel" varchar(128);--> statement-breakpoint
ALTER TABLE "ProjectFact" ADD COLUMN "embeddingDims" integer;--> statement-breakpoint
ALTER TABLE "ProjectFact" ADD COLUMN "embeddedAt" timestamp;--> statement-breakpoint
CREATE INDEX "ProjectFact_embedding_idx" ON "ProjectFact" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
ALTER TABLE "ProjectFact" ADD CONSTRAINT "ProjectFact_embedding_labelled" CHECK (("ProjectFact"."embedding" IS NULL) = ("ProjectFact"."embeddingModel" IS NULL)
          AND ("ProjectFact"."embedding" IS NULL) = ("ProjectFact"."embeddingDims" IS NULL));