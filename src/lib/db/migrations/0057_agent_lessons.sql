CREATE TABLE "agent_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"rule" text NOT NULL,
	"wrong" text NOT NULL,
	"fix" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"makers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_lessons_key_idx" ON "agent_lessons" USING btree ("key");--> statement-breakpoint
CREATE INDEX "agent_lessons_count_idx" ON "agent_lessons" USING btree ("count");