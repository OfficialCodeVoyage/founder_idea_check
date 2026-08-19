CREATE TABLE "ProjectFact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"projectId" uuid NOT NULL,
	"phaseKey" varchar(64) NOT NULL,
	"key" varchar(128) NOT NULL,
	"value" text NOT NULL,
	"confidence" integer DEFAULT 50 NOT NULL,
	"sourceMessageId" uuid,
	"extractedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ProjectFact_confidence_range" CHECK ("ProjectFact"."confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "ProjectPhase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"projectId" uuid NOT NULL,
	"phaseKey" varchar(64) NOT NULL,
	"phaseOrder" integer NOT NULL,
	"status" varchar DEFAULT 'active' NOT NULL,
	"decision" varchar,
	"reason" text,
	"nextQuestion" text,
	"verdict" json,
	"attemptCount" integer DEFAULT 0 NOT NULL,
	"evaluatedAt" timestamp
);
--> statement-breakpoint
ALTER TABLE "ProjectFact" ADD CONSTRAINT "ProjectFact_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProjectFact" ADD CONSTRAINT "ProjectFact_sourceMessageId_Message_id_fk" FOREIGN KEY ("sourceMessageId") REFERENCES "public"."Message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProjectPhase" ADD CONSTRAINT "ProjectPhase_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ProjectFact_project_id_idx" ON "ProjectFact" USING btree ("projectId");--> statement-breakpoint
CREATE UNIQUE INDEX "ProjectFact_project_key_unique" ON "ProjectFact" USING btree ("projectId","key");--> statement-breakpoint
CREATE INDEX "ProjectPhase_project_id_idx" ON "ProjectPhase" USING btree ("projectId");--> statement-breakpoint
CREATE UNIQUE INDEX "ProjectPhase_project_phase_unique" ON "ProjectPhase" USING btree ("projectId","phaseKey");