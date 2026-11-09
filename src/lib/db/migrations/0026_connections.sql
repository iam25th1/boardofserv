CREATE TABLE IF NOT EXISTS "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"lookup" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "connections_provider" CHECK ("connections"."provider" in ('telegram', 'google'))
);
--> statement-breakpoint
ALTER TABLE "agent_installations" ADD COLUMN "paused_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connections" ADD CONSTRAINT "connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connections_owner_provider_idx" ON "connections" USING btree ("owner_user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connections_lookup_idx" ON "connections" USING btree ("provider","lookup");