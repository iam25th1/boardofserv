CREATE TABLE IF NOT EXISTS "freezes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"lift_reason" text,
	CONSTRAINT "freezes_kind" CHECK ("freezes"."kind" in ('agent', 'version', 'maker', 'renter'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "stop_note" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "freezes" ADD CONSTRAINT "freezes_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "freezes" ADD CONSTRAINT "freezes_lifted_by_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "freezes_target_idx" ON "freezes" USING btree ("kind","target_id","lifted_at");