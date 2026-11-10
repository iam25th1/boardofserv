CREATE TABLE IF NOT EXISTS "payees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"suggested_by" text,
	"first_paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	CONSTRAINT "payees_status" CHECK ("payees"."status" in ('active', 'suggested', 'removed'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payees" ADD CONSTRAINT "payees_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payees_installation_idx" ON "payees" USING btree ("installation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payees_label_idx" ON "payees" USING btree ("installation_id",lower("label")) WHERE "payees"."status" <> 'removed';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payees_address_idx" ON "payees" USING btree ("installation_id",lower("address")) WHERE "payees"."status" <> 'removed';