CREATE TABLE IF NOT EXISTS "agent_listings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"weekly_price" numeric(78, 0) DEFAULT '0' NOT NULL,
	"job_fee" numeric(78, 0) DEFAULT '0' NOT NULL,
	"listed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_listings_prices" CHECK ("agent_listings"."weekly_price" >= 0 and "agent_listings"."job_fee" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_listings" ADD CONSTRAINT "agent_listings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_listings" ADD CONSTRAINT "agent_listings_version_id_agent_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."agent_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_listings_listed_idx" ON "agent_listings" USING btree ("listed","weekly_price");