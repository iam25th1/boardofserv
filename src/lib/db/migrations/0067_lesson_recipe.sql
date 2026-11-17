ALTER TABLE "agent_lessons" ADD COLUMN "recipe" text;--> statement-breakpoint
ALTER TABLE "agent_lessons" ADD COLUMN "live" integer DEFAULT 0 NOT NULL;