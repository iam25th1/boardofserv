ALTER TABLE "reply_usage" ADD COLUMN "extract_prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "reply_usage" ADD COLUMN "extract_completion_tokens" integer;--> statement-breakpoint
ALTER TABLE "reply_usage" ADD COLUMN "extract_ms" integer;--> statement-breakpoint
ALTER TABLE "reply_usage" ADD COLUMN "extract_outcome" text;