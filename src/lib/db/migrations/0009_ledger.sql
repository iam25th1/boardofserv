CREATE TABLE IF NOT EXISTS "balances" (
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"available" numeric(78, 0) DEFAULT '0' NOT NULL,
	"held" numeric(78, 0) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balances_user_id_currency_pk" PRIMARY KEY("user_id","currency"),
	CONSTRAINT "balances_currency" CHECK ("balances"."currency" in ('USDC', 'SERV')),
	CONSTRAINT "balances_available_not_negative" CHECK ("balances"."available" >= 0),
	CONSTRAINT "balances_held_not_negative" CHECK ("balances"."held" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"currency" text NOT NULL,
	"amount" text NOT NULL,
	"kind" text NOT NULL,
	"reference_id" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ledger_entries_currency" CHECK ("ledger_entries"."currency" in ('USDC', 'SERV')),
	CONSTRAINT "ledger_entries_kind" CHECK ("ledger_entries"."kind" in ('deposit', 'use_charge', 'maker_earning', 'platform_fee', 'withdrawal', 'withdrawal_reversal')),
	CONSTRAINT "ledger_entries_amount_whole" CHECK ("ledger_entries"."amount" ~ '^-?[1-9][0-9]{0,77}$'),
	CONSTRAINT "ledger_entries_sign" CHECK (("ledger_entries"."kind" in ('use_charge', 'withdrawal')) = ("ledger_entries"."amount" like '-%')),
	CONSTRAINT "ledger_entries_platform" CHECK (("ledger_entries"."kind" = 'platform_fee') = ("ledger_entries"."user_id" is null))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "balances" ADD CONSTRAINT "balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entries_user_idx" ON "ledger_entries" USING btree ("user_id","currency","created_at");