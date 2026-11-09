CREATE TABLE IF NOT EXISTS "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_kind" CHECK ("reports"."kind" in ('agent', 'maker', 'request', 'offer')),
	CONSTRAINT "reports_reason" CHECK ("reports"."reason" in ('scam', 'harmful', 'personal_data', 'spam', 'misleading', 'other')),
	CONSTRAINT "reports_status" CHECK ("reports"."status" in ('open', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "agent_listings" ADD COLUMN "screen" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_listings" ADD COLUMN "screen_reason" text;--> statement-breakpoint
ALTER TABLE "agent_listings" ADD COLUMN "screen_hash" text;--> statement-breakpoint
ALTER TABLE "request_offers" ADD COLUMN "screen" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_offers" ADD COLUMN "screen_reason" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "screen" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "screen_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_status_idx" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reports_once" ON "reports" USING btree ("kind","target_id","reporter_user_id");