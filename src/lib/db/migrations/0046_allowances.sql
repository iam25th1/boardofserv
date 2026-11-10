CREATE TABLE IF NOT EXISTS "allowance_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"reference_id" text,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowance_entries_kind" CHECK ("allowance_entries"."kind" in ('topup', 'withdraw', 'hold', 'release', 'spend')),
	CONSTRAINT "allowance_entries_amount_positive" CHECK ("allowance_entries"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "allowances" (
	"installation_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"currency" text DEFAULT 'USDC' NOT NULL,
	"available" numeric(78, 0) DEFAULT '0' NOT NULL,
	"held" numeric(78, 0) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowances_usdc" CHECK ("allowances"."currency" = 'USDC'),
	CONSTRAINT "allowances_available_not_negative" CHECK ("allowances"."available" >= 0),
	CONSTRAINT "allowances_held_not_negative" CHECK ("allowances"."held" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "allowances" ADD CONSTRAINT "allowances_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "allowance_entries_key_idx" ON "allowance_entries" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "allowance_entries_installation_idx" ON "allowance_entries" USING btree ("installation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "allowances_owner_idx" ON "allowances" USING btree ("owner_user_id");