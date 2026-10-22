CREATE TABLE IF NOT EXISTS "helper_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"helper_id" uuid,
	"user_id" uuid NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "helper_uses" ADD CONSTRAINT "helper_uses_helper_id_published_helpers_id_fk" FOREIGN KEY ("helper_id") REFERENCES "public"."published_helpers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "helper_uses" ADD CONSTRAINT "helper_uses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "helper_uses_user_idx" ON "helper_uses" USING btree ("user_id","created_at");