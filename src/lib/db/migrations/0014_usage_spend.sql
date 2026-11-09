ALTER TABLE "helper_uses" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "helper_uses" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "helper_uses" ADD COLUMN "own_key" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_usage" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "reply_usage" ADD COLUMN "kind" text DEFAULT 'reply' NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_usage" ADD COLUMN "own_key" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_usage" ADD COLUMN "extract_provider" text;--> statement-breakpoint
ALTER TABLE "reply_usage" ADD COLUMN "extract_model" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reply_usage" ADD CONSTRAINT "reply_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reply_usage_user_idx" ON "reply_usage" USING btree ("user_id","created_at");