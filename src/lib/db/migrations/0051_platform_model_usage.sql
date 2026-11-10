CREATE TABLE IF NOT EXISTS "platform_model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
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
CREATE INDEX IF NOT EXISTS "platform_model_usage_day_idx" ON "platform_model_usage" USING btree ("day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_model_usage_created_idx" ON "platform_model_usage" USING btree ("created_at");