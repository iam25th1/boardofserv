CREATE TABLE IF NOT EXISTS "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"definition" jsonb,
	"code" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bench" jsonb,
	"build_state" text DEFAULT 'idle' NOT NULL,
	"build_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "agent_versions_state" CHECK ("agent_versions"."state" in ('draft', 'published')),
	CONSTRAINT "agent_versions_published_at" CHECK (("agent_versions"."state" = 'published') = ("agent_versions"."published_at" is not null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_conversation_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_versions_number_idx" ON "agent_versions" USING btree ("agent_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_versions_draft_idx" ON "agent_versions" USING btree ("agent_id") WHERE "agent_versions"."state" = 'draft';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_owner_idx" ON "agents" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_conversation_idx" ON "agents" USING btree ("source_conversation_id");