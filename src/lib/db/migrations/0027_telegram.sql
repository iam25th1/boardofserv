CREATE TABLE IF NOT EXISTS "telegram_link_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"installation_ids" jsonb NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_webhook" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"secret_hash" text NOT NULL,
	"previous_hash" text,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_webhook_one" CHECK ("telegram_webhook"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD COLUMN "tg_state" text;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD COLUMN "tg_message_id" integer;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD COLUMN "tg_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "tg_state" text;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "tg_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "telegram_pending" ADD CONSTRAINT "telegram_pending_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_link_codes_owner_idx" ON "telegram_link_codes" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_pending_owner_idx" ON "telegram_pending" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_approvals_tg_idx" ON "agent_approvals" USING btree ("tg_state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_messages_tg_idx" ON "agent_messages" USING btree ("tg_state");