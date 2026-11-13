-- HAND-WRITTEN. drizzle-kit generated the column and the CHECK; the CHECK is
-- rewritten here because a generated CHECK is never trusted (Incident 9), and
-- both statements are guarded so this also runs on a database that `push`
-- already changed (same posture as 0052 and 0053).
--
-- A founder can point a user message at one exit criterion of the current
-- phase: its criterion target. Until this column existed the target lived only
-- in the request: lib/message-conversion.ts maps metadata field by field, so
-- the "Answering: X" label vanished on reload and a regenerate after reload
-- lost the target.
--
-- NULL means no target. The value is a claim about intent, not a foreign key:
-- it is not tied to a phase, because the phase moves on and the target must
-- still read back as what the founder said at the time. Whether it names a
-- criterion of the current phase is decided per turn, in buildPhaseSystemBlock.
--
-- The CHECK spells TARGET_CRITERION_ID_PATTERN (lib/ai/types.ts) in SQL: the
-- shape chatMessageToDbMessage stores (it writes anything else as NULL), so a
-- row written by any other path cannot store text that the bubble and the
-- prompt would then replay.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "targetCriterionId" varchar(64);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Message_target_criterion_shape' AND conrelid = '"Message"'::regclass) THEN
    ALTER TABLE "Message" ADD CONSTRAINT "Message_target_criterion_shape" CHECK ("Message"."targetCriterionId" IS NULL OR "Message"."targetCriterionId" ~ '^[a-z0-9-]{1,64}$');
  END IF;
END $$;
