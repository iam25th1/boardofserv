CREATE TABLE IF NOT EXISTS "reply_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"provider" text,
	"model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"first_token_ms" integer,
	"total_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reply_usage" ADD CONSTRAINT "reply_usage_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reply_usage_created_idx" ON "reply_usage" USING btree ("created_at");