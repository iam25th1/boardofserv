CREATE TABLE IF NOT EXISTS "helper_prices" (
	"helper_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"price" numeric(78, 0) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "helper_prices_helper_id_currency_pk" PRIMARY KEY("helper_id","currency"),
	CONSTRAINT "helper_prices_currency" CHECK ("helper_prices"."currency" in ('USDC', 'SERV')),
	CONSTRAINT "helper_prices_positive" CHECK ("helper_prices"."price" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"helper_id" uuid,
	"maker_user_id" uuid NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "holds_currency" CHECK ("holds"."currency" in ('USDC', 'SERV')),
	CONSTRAINT "holds_status" CHECK ("holds"."status" in ('held', 'captured', 'released')),
	CONSTRAINT "holds_amount_positive" CHECK ("holds"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "helper_uses" ADD COLUMN "hold_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "helper_prices" ADD CONSTRAINT "helper_prices_helper_id_published_helpers_id_fk" FOREIGN KEY ("helper_id") REFERENCES "public"."published_helpers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "holds" ADD CONSTRAINT "holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "holds" ADD CONSTRAINT "holds_helper_id_published_helpers_id_fk" FOREIGN KEY ("helper_id") REFERENCES "public"."published_helpers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "holds" ADD CONSTRAINT "holds_maker_user_id_users_id_fk" FOREIGN KEY ("maker_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holds_status_idx" ON "holds" USING btree ("status","created_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "helper_uses" ADD CONSTRAINT "helper_uses_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."holds"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
