ALTER TABLE "agent_listings" ADD COLUMN "quality_cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reppo_evals" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reppo_evals" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "reppo_evals" ADD COLUMN "resolution" text;