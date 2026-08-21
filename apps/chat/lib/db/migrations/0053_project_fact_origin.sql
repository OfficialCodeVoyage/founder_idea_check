-- A founder can now correct a fact. That changes what ProjectFact IS.
--
-- Every row here used to be extractor-written by construction, so "where did
-- this claim come from" needed no column. It does now. The gate reads facts,
-- and the persona, the simulation and the export are all grounded in them — so
-- a founder who could silently rewrite a value would be able to launder their
-- own assumption into evidence and then pass their own gate on it. That is the
-- failure this product exists to prevent, arriving through an edit button.
--
-- `origin` defaults to 'extracted', which is the truth about every existing
-- row: they were all written by the extractor. No backfill is needed and none
-- would be honest.
--
-- Provenance is NOT derived from `sourceMessageId IS NULL`. That column is
-- already null for extractor writes that had no assistant message id, and it is
-- ON DELETE SET NULL — deleting a message would retroactively relabel an
-- extracted fact as founder-asserted. An overloaded null is not a record.
--
-- The CHECK is the same posture as ProjectFact_embedding_labelled directly
-- above it and SimulationRun_assessment_coherent in 0052: the two columns move
-- together, so "founder-asserted with no correction time" and "extracted yet
-- carrying one" are both unstorable rather than merely discouraged.
ALTER TABLE "ProjectFact" ADD COLUMN IF NOT EXISTS "origin" varchar DEFAULT 'extracted' NOT NULL;--> statement-breakpoint
ALTER TABLE "ProjectFact" ADD COLUMN IF NOT EXISTS "correctedAt" timestamp;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProjectFact_origin_coherent' AND conrelid = '"ProjectFact"'::regclass) THEN
    ALTER TABLE "ProjectFact" ADD CONSTRAINT "ProjectFact_origin_coherent" CHECK (("ProjectFact"."origin" = 'founder') = ("ProjectFact"."correctedAt" IS NOT NULL));
  END IF;
END $$;
