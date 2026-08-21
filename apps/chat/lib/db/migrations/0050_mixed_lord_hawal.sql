CREATE TABLE "SimulationProfile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"projectId" uuid NOT NULL,
	"personaDocumentId" uuid NOT NULL,
	"handle" varchar(64) NOT NULL,
	"age" integer NOT NULL,
	"gender" text NOT NULL,
	"country" text NOT NULL,
	"mbti" varchar(8),
	CONSTRAINT "SimulationProfile_age_range" CHECK ("SimulationProfile"."age" BETWEEN 13 AND 120),
	CONSTRAINT "SimulationProfile_text_present" CHECK (char_length(btrim("SimulationProfile"."handle")) > 0
          AND char_length(btrim("SimulationProfile"."gender")) > 0
          AND char_length(btrim("SimulationProfile"."country")) > 0
          AND ("SimulationProfile"."mbti" IS NULL OR char_length(btrim("SimulationProfile"."mbti")) > 0))
);
--> statement-breakpoint
ALTER TABLE "SimulationProfile" ADD CONSTRAINT "SimulationProfile_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "SimulationProfile_project_idx" ON "SimulationProfile" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "SimulationProfile_persona_idx" ON "SimulationProfile" USING btree ("personaDocumentId");--> statement-breakpoint
CREATE UNIQUE INDEX "SimulationProfile_project_handle_unique" ON "SimulationProfile" USING btree ("projectId","handle");