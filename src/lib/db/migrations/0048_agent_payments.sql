CREATE TABLE IF NOT EXISTS "agent_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"installation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"job_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"payee_id" uuid NOT NULL,
	"payee_label" text NOT NULL,
	"to_address" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"currency" text DEFAULT 'USDC' NOT NULL,
	"chain_id" integer NOT NULL,
	"memo" text,
	"status" text DEFAULT 'held' NOT NULL,
	"from_address" text,
	"nonce" integer,
	"tx_hash" text,
	"raw_tx" text,
	"sends" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"block_number" numeric(78, 0),
	"guard" text,
	"guard_reason" text,
	"approval_id" uuid,
	"approved_by" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"broadcast_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_payments_status" CHECK ("agent_payments"."status" in ('held', 'broadcast', 'confirmed', 'failed')),
	CONSTRAINT "agent_payments_amount_positive" CHECK ("agent_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text,
	CONSTRAINT "payment_alerts_status" CHECK ("payment_alerts"."status" in ('open', 'resolved'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_payments" ADD CONSTRAINT "agent_payments_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_payments_key_idx" ON "agent_payments" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_payments_one_in_flight" ON "agent_payments" USING btree ("chain_id") WHERE "agent_payments"."status" = 'broadcast';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_payments_installation_idx" ON "agent_payments" USING btree ("installation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_payments_agent_idx" ON "agent_payments" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_payments_status_idx" ON "agent_payments" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_payments_tx_idx" ON "agent_payments" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_alerts_key_idx" ON "payment_alerts" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_alerts_status_idx" ON "payment_alerts" USING btree ("status","created_at");