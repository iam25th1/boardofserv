CREATE TABLE IF NOT EXISTS "agent_job_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"step_id" text NOT NULL,
	"status" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"note" text,
	"model" text,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" jsonb NOT NULL,
	"state" jsonb,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"heartbeat_at" timestamp with time zone,
	"stop_asked" boolean DEFAULT false NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_jobs_status" CHECK ("agent_jobs"."status" in ('queued', 'running', 'waiting_for_owner', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_job_steps" ADD CONSTRAINT "agent_job_steps_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_version_id_agent_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."agent_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_job_steps_seq_idx" ON "agent_job_steps" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_jobs_due_idx" ON "agent_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_jobs_installation_idx" ON "agent_jobs" USING btree ("installation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_jobs_owner_idx" ON "agent_jobs" USING btree ("owner_user_id","created_at");