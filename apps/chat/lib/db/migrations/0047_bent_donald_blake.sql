CREATE TABLE "ProjectPersona" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"projectId" uuid NOT NULL,
	"name" text NOT NULL,
	"headline" text NOT NULL,
	"description" text NOT NULL,
	"age" integer NOT NULL,
	"gender" text NOT NULL,
	"country" text NOT NULL,
	"mbti" text,
	"evidence" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ProjectTask" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"projectId" uuid NOT NULL,
	"taskId" varchar(256) NOT NULL,
	"phaseKey" varchar(64) NOT NULL,
	"criterionId" varchar(64) NOT NULL,
	"state" varchar DEFAULT 'todo' NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"producesFactKey" varchar(128)
);
--> statement-breakpoint
CREATE TABLE "SimulationRun" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"projectId" uuid NOT NULL,
	"pitch" text NOT NULL,
	"divergence" jsonb NOT NULL,
	"usable" boolean NOT NULL,
	"reactions" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Document" ALTER COLUMN "messageId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "Document" ADD COLUMN "projectId" uuid;--> statement-breakpoint
ALTER TABLE "ProjectPersona" ADD CONSTRAINT "ProjectPersona_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProjectTask" ADD CONSTRAINT "ProjectTask_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ProjectPersona_project_id_idx" ON "ProjectPersona" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "ProjectTask_project_id_idx" ON "ProjectTask" USING btree ("projectId");--> statement-breakpoint
CREATE UNIQUE INDEX "ProjectTask_project_task_unique" ON "ProjectTask" USING btree ("projectId","taskId");--> statement-breakpoint
CREATE INDEX "SimulationRun_project_id_idx" ON "SimulationRun" USING btree ("projectId");--> statement-breakpoint
ALTER TABLE "Document" ADD CONSTRAINT "Document_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Document_project_kind_idx" ON "Document" USING btree ("projectId","kind");