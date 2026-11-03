CREATE TABLE IF NOT EXISTS "chain_cursors" (
	"key" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"currency" text NOT NULL,
	"from_address" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"user_id" uuid,
	"status" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "deposits_currency" CHECK ("deposits"."currency" in ('USDC', 'SERV')),
	CONSTRAINT "deposits_status" CHECK ("deposits"."status" in ('confirming', 'credited', 'unmatched', 'dropped')),
	CONSTRAINT "deposits_amount_positive" CHECK ("deposits"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linked_wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"embedded" boolean DEFAULT false NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linked_wallets_lower_case" CHECK ("linked_wallets"."address" = lower("linked_wallets"."address"))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "linked_wallets" ADD CONSTRAINT "linked_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deposits_log_idx" ON "deposits" USING btree ("chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deposits_user_idx" ON "deposits" USING btree ("user_id","seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deposits_status_idx" ON "deposits" USING btree ("status","seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linked_wallets_user_idx" ON "linked_wallets" USING btree ("user_id");