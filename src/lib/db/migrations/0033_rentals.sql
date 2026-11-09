CREATE TABLE IF NOT EXISTS "rental_charges" (
	"rental_id" uuid NOT NULL,
	"week" integer NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"hold_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rental_charges_rental_id_week_pk" PRIMARY KEY("rental_id","week")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rentals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"renter_user_id" uuid NOT NULL,
	"maker_user_id" uuid NOT NULL,
	"installation_id" uuid,
	"weekly_price" numeric(78, 0) NOT NULL,
	"job_fee" numeric(78, 0) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"renews" boolean DEFAULT true NOT NULL,
	"paid_until" timestamp with time zone NOT NULL,
	"weeks_paid" integer DEFAULT 0 NOT NULL,
	"offered_version_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rentals_status" CHECK ("rentals"."status" in ('active', 'unpaid', 'ended')),
	CONSTRAINT "rentals_prices" CHECK ("rentals"."weekly_price" >= 0 and "rentals"."job_fee" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "fee_hold_id" uuid;--> statement-breakpoint
ALTER TABLE "holds" ADD COLUMN "kind" text DEFAULT 'use' NOT NULL;--> statement-breakpoint
ALTER TABLE "holds" ADD COLUMN "job_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental_charges" ADD CONSTRAINT "rental_charges_rental_id_rentals_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rentals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rentals" ADD CONSTRAINT "rentals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rentals" ADD CONSTRAINT "rentals_version_id_agent_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."agent_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rentals" ADD CONSTRAINT "rentals_renter_user_id_users_id_fk" FOREIGN KEY ("renter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rentals" ADD CONSTRAINT "rentals_maker_user_id_users_id_fk" FOREIGN KEY ("maker_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rentals" ADD CONSTRAINT "rentals_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rentals" ADD CONSTRAINT "rentals_offered_version_id_agent_versions_id_fk" FOREIGN KEY ("offered_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rentals_renter_idx" ON "rentals" USING btree ("renter_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rentals_agent_idx" ON "rentals" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rentals_due_idx" ON "rentals" USING btree ("status","paid_until");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holds_kind_idx" ON "holds" USING btree ("kind","status");