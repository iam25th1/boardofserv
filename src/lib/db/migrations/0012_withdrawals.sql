CREATE TABLE IF NOT EXISTS "payment_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"to_address" text NOT NULL,
	"status" text NOT NULL,
	"auto" boolean NOT NULL,
	"reason" text,
	"idempotency_key" text NOT NULL,
	"nonce" integer,
	"tx_hash" text,
	"raw_tx" text,
	"broadcast_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"sends" integer DEFAULT 0 NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawals_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "withdrawals_currency" CHECK ("withdrawals"."currency" in ('USDC', 'SERV')),
	CONSTRAINT "withdrawals_status" CHECK ("withdrawals"."status" in ('awaiting_approval', 'queued', 'broadcast', 'paid', 'reverted', 'rejected', 'failed')),
	CONSTRAINT "withdrawals_amount_positive" CHECK ("withdrawals"."amount" > 0),
	CONSTRAINT "withdrawals_sent_has_hash" CHECK ("withdrawals"."status" not in ('broadcast', 'paid', 'reverted') or ("withdrawals"."tx_hash" is not null and "withdrawals"."nonce" is not null))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_user_idx" ON "withdrawals" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_status_idx" ON "withdrawals" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_one_in_flight" ON "withdrawals" USING btree ("chain_id") WHERE "withdrawals"."status" = 'broadcast';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_nonce_idx" ON "withdrawals" USING btree ("chain_id","nonce") WHERE "withdrawals"."status" in ('broadcast', 'paid', 'reverted');