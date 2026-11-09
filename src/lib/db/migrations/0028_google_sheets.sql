CREATE TABLE IF NOT EXISTS "agent_tool_days" (
	"installation_id" uuid NOT NULL,
	"day" text NOT NULL,
	"tool" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_tool_days_installation_id_day_tool_pk" PRIMARY KEY("installation_id","day","tool")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_installations" ADD COLUMN "sheets" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
