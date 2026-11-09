CREATE TABLE IF NOT EXISTS "agent_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"memory" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mocks" jsonb NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"schedule" jsonb,
	"min_gap_minutes" integer DEFAULT 5 NOT NULL,
	"daily_spend_usd" numeric(10, 4) DEFAULT '0.5' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	CONSTRAINT "agent_installations_status" CHECK ("agent_installations"."status" in ('active', 'paused', 'stopped')),
	CONSTRAINT "agent_installations_gap" CHECK ("agent_installations"."min_gap_minutes" between 0 and 1440)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_version_id_agent_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."agent_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_installations_owner_idx" ON "agent_installations" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_installations_agent_idx" ON "agent_installations" USING btree ("agent_id");