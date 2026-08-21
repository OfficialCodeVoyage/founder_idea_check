CREATE TABLE "ProjectPhaseAttempt" (
	"projectId" uuid NOT NULL,
	"phaseKey" varchar(64) NOT NULL,
	"attemptNo" integer NOT NULL,
	"decision" varchar NOT NULL,
	"reason" text NOT NULL,
	"nextQuestion" text,
	"verdict" json,
	"status" varchar NOT NULL,
	"evaluatedAt" timestamp NOT NULL,
	CONSTRAINT "ProjectPhaseAttempt_projectId_phaseKey_evaluatedAt_pk" PRIMARY KEY("projectId","phaseKey","evaluatedAt")
);
--> statement-breakpoint
ALTER TABLE "ProjectPhaseAttempt" ADD CONSTRAINT "ProjectPhaseAttempt_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ProjectPhaseAttempt_project_phase_idx" ON "ProjectPhaseAttempt" USING btree ("projectId","phaseKey");--> statement-breakpoint
-- Seed the ledger from the one verdict per phase that survived the overwrite.
-- This recovers the LAST verdict only; every earlier refusal was already
-- destroyed by the old onConflictDoUpdate and is not recoverable. attemptCount
-- is preserved as the ordinal so the numbering stays continuous with it, and
-- rows with no decision (a phase activated but never assessed) are skipped
-- rather than invented -- "never assessed" must not become a verdict.
INSERT INTO "ProjectPhaseAttempt" (
  "projectId", "phaseKey", "attemptNo", "decision",
  "reason", "nextQuestion", "verdict", "status", "evaluatedAt"
)
SELECT
  p."projectId",
  p."phaseKey",
  GREATEST(p."attemptCount", 1),
  p."decision",
  p."reason",
  p."nextQuestion",
  p."verdict",
  p."status",
  COALESCE(p."evaluatedAt", p."updatedAt")
FROM "ProjectPhase" p
WHERE p."decision" IS NOT NULL
  AND p."reason" IS NOT NULL
ON CONFLICT DO NOTHING;
