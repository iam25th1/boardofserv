CREATE TABLE IF NOT EXISTS "agent_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"call_index" integer NOT NULL,
	"kind" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"no_answer" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" text,
	"expires_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_approvals_status" CHECK ("agent_approvals"."status" in ('pending', 'answered', 'expired', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "agent_jobs" ALTER COLUMN "state" SET DATA TYPE json;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_approvals_owner_idx" ON "agent_approvals" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_approvals_due_idx" ON "agent_approvals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_approvals_job_idx" ON "agent_approvals" USING btree ("job_id");