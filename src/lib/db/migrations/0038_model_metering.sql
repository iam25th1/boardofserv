CREATE TABLE IF NOT EXISTS "agent_model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"job_id" uuid,
	"agent_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"provider" text,
	"model" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost" numeric(78, 0) DEFAULT '0' NOT NULL,
	"own_key" boolean DEFAULT false NOT NULL,
	"day" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_installations" ADD COLUMN "model_budget" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "model_settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_listings" ADD COLUMN "model_budget" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "agent_listings" ADD COLUMN "model_share" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rentals" ADD COLUMN "model_share" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_usage" ADD CONSTRAINT "agent_model_usage_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_usage" ADD CONSTRAINT "agent_model_usage_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_model_usage_installation_idx" ON "agent_model_usage" USING btree ("installation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_model_usage_job_idx" ON "agent_model_usage" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_model_usage_day_idx" ON "agent_model_usage" USING btree ("day");