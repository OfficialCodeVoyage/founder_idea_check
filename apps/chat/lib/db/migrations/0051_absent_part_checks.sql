-- HAND-ADDED, and it must stay hand-added.
-- drizzle-kit recorded all seven "Part" CHECK constraints in 0044_snapshot.json
-- but emitted no CHECK DDL in 0044_gray_red_shift.sql. Because every later
-- `generate` diffs against a snapshot that already claims they exist, no
-- subsequent migration ever emitted them either. The dev database has them only
-- because it was built with `drizzle-kit push`; a database built by replaying
-- the migration chain has none of them. Proven by T1: a from-zero replay yields
-- 4 of the 11 CHECK constraints declared in schema.ts.
--
-- Guarded with IF NOT EXISTS semantics because databases built by `push`
-- (every developer machine) already carry these constraints. Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS, hence the DO blocks.
--
-- The expressions below are drizzle-kit's own output for these constraints,
-- copied verbatim from a `push --verbose` run, so they match schema.ts exactly.
-- See DATA-LAYER.md.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Part_text_required_if_type_text' AND conrelid = '"Part"'::regclass) THEN
    ALTER TABLE "Part" ADD CONSTRAINT "Part_text_required_if_type_text" CHECK (CASE WHEN "Part"."type" = 'text' THEN "Part"."text_text" IS NOT NULL ELSE TRUE END);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Part_reasoning_required_if_type_reasoning' AND conrelid = '"Part"'::regclass) THEN
    ALTER TABLE "Part" ADD CONSTRAINT "Part_reasoning_required_if_type_reasoning" CHECK (CASE WHEN "Part"."type" = 'reasoning' THEN "Part"."reasoning_text" IS NOT NULL ELSE TRUE END);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Part_file_required_if_type_file' AND conrelid = '"Part"'::regclass) THEN
    ALTER TABLE "Part" ADD CONSTRAINT "Part_file_required_if_type_file" CHECK (CASE WHEN "Part"."type" = 'file' THEN "Part"."file_mediaType" IS NOT NULL AND "Part"."file_url" IS NOT NULL ELSE TRUE END);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Part_source_url_required_if_type_source_url' AND conrelid = '"Part"'::regclass) THEN
    ALTER TABLE "Part" ADD CONSTRAINT "Part_source_url_required_if_type_source_url" CHECK (CASE WHEN "Part"."type" = 'source-url' THEN "Part"."source_url_sourceId" IS NOT NULL AND "Part"."source_url_url" IS NOT NULL ELSE TRUE END);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Part_source_document_required_if_type_source_document' AND conrelid = '"Part"'::regclass) THEN
    ALTER TABLE "Part" ADD CONSTRAINT "Part_source_document_required_if_type_source_document" CHECK (CASE WHEN "Part"."type" = 'source-document' THEN "Part"."source_document_sourceId" IS NOT NULL AND "Part"."source_document_mediaType" IS NOT NULL AND "Part"."source_document_title" IS NOT NULL ELSE TRUE END);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Part_tool_required_if_type_tool' AND conrelid = '"Part"'::regclass) THEN
    ALTER TABLE "Part" ADD CONSTRAINT "Part_tool_required_if_type_tool" CHECK (CASE WHEN "Part"."type" LIKE 'tool-%' THEN "Part"."tool_toolCallId" IS NOT NULL AND "Part"."tool_state" IS NOT NULL ELSE TRUE END);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Part_data_required_if_type_data' AND conrelid = '"Part"'::regclass) THEN
    ALTER TABLE "Part" ADD CONSTRAINT "Part_data_required_if_type_data" CHECK (CASE WHEN "Part"."type" LIKE 'data-%' THEN "Part"."data_type" IS NOT NULL ELSE TRUE END);
  END IF;
END $$;
