ALTER TABLE "agent_approvals" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "agent_installations" ADD COLUMN "policy" jsonb DEFAULT '{}'::jsonb NOT NULL;