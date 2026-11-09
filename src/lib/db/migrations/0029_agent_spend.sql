CREATE TABLE IF NOT EXISTS "agent_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"job_id" uuid,
	"action_id" text,
	"tool" text NOT NULL,
	"amount_usdc" numeric(18, 6) NOT NULL,
	"day" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_spend" ADD CONSTRAINT "agent_spend_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_spend" ADD CONSTRAINT "agent_spend_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_spend_day_idx" ON "agent_spend" USING btree ("installation_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_spend_job_idx" ON "agent_spend" USING btree ("job_id");