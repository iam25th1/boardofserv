CREATE TABLE IF NOT EXISTS "reppo_evals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"job_id" uuid,
	"approval_id" uuid,
	"task_type" text NOT NULL,
	"input" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reppo_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"polls" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"score" integer,
	"route" text,
	"decision" text,
	"confidence" text,
	"reason" text,
	"rubric" jsonb,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reppo_evals_key_idx" ON "reppo_evals" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reppo_evals_due_idx" ON "reppo_evals" USING btree ("status","next_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reppo_evals_version_idx" ON "reppo_evals" USING btree ("version_id","completed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reppo_evals_agent_idx" ON "reppo_evals" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reppo_evals_submitted_idx" ON "reppo_evals" USING btree ("submitted_at");