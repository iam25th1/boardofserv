CREATE TABLE IF NOT EXISTS "request_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"maker_user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"weekly_price" numeric(78, 0) NOT NULL,
	"job_fee" numeric(78, 0) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"rental_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_offers_status" CHECK ("request_offers"."status" in ('open', 'accepted', 'withdrawn')),
	CONSTRAINT "request_offers_prices" CHECK ("request_offers"."weekly_price" >= 0 and "request_offers"."job_fee" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_votes" (
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_votes_request_id_user_id_pk" PRIMARY KEY("request_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"need" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"connects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget" numeric(78, 0),
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_status" CHECK ("requests"."status" in ('open', 'accepted', 'closed')),
	CONSTRAINT "requests_budget" CHECK ("requests"."budget" is null or "requests"."budget" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_offers" ADD CONSTRAINT "request_offers_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_offers" ADD CONSTRAINT "request_offers_maker_user_id_users_id_fk" FOREIGN KEY ("maker_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_offers" ADD CONSTRAINT "request_offers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_offers" ADD CONSTRAINT "request_offers_rental_id_rentals_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rentals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_votes" ADD CONSTRAINT "request_votes_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_votes" ADD CONSTRAINT "request_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "requests" ADD CONSTRAINT "requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_offers_request_idx" ON "request_offers" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "request_offers_agent_once" ON "request_offers" USING btree ("request_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requests_status_idx" ON "requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requests_user_idx" ON "requests" USING btree ("user_id");