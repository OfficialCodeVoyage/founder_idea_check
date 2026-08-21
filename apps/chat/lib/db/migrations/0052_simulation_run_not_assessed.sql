-- A simulation run that produced nothing is NOT a verdict.
--
-- `usable` was `NOT NULL`, so the only thing a run with zero reactions could be
-- written as was `false` — and `false` is the COLLAPSED badge. A run in which
-- every agent call returned 400 was therefore stored, listed and coloured
-- exactly like a run in which the personas unanimously agreed. Those two facts
-- point a founder in opposite directions: one says reseed from more facts, the
-- other says go and look at your model configuration.
--
-- Dropping NOT NULL gives the column a third state that means what it says.
-- `notAssessedKind` carries WHICH refusal it was, and `agentErrors` carries how
-- many agent actions failed — NULL there means "not counted", never zero.
--
-- The CHECK is what keeps the two columns from disagreeing: a row is either
-- assessed (usable non-null, kind null) or not (usable null, kind non-null),
-- and no other combination is storable. Without it, `usable IS NULL` with no
-- stated reason would read as a verdict to anything that only inspects one
-- column.
--
-- Existing rows are untouched and stay assessed. That includes the original
-- reproduction row, which is deliberately left as it is: it is the evidence of
-- what this shape used to allow.
ALTER TABLE "SimulationRun" ALTER COLUMN "usable" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "SimulationRun" ADD COLUMN IF NOT EXISTS "notAssessedKind" varchar(32);--> statement-breakpoint
ALTER TABLE "SimulationRun" ADD COLUMN IF NOT EXISTS "agentErrors" integer;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SimulationRun_assessment_coherent' AND conrelid = '"SimulationRun"'::regclass) THEN
    ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_assessment_coherent" CHECK (("SimulationRun"."usable" IS NULL) = ("SimulationRun"."notAssessedKind" IS NOT NULL));
  END IF;
END $$;
