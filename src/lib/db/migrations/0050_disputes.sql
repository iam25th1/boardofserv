CREATE TABLE IF NOT EXISTS "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"renter_user_id" uuid NOT NULL,
	"maker_user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version_id" uuid,
	"installation_id" uuid,
	"payment_id" uuid,
	"rental_id" uuid,
	"week" integer,
	"hold_id" uuid,
	"amount" numeric(78, 0) NOT NULL,
	"reason" text NOT NULL,
	"note" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"refund" text DEFAULT 'none' NOT NULL,
	"maker_reversed" numeric(78, 0),
	"platform_reversed" numeric(78, 0),
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_kind" CHECK ("disputes"."kind" in ('payment', 'rent')),
	CONSTRAINT "disputes_reason" CHECK ("disputes"."reason" in ('not_done', 'not_wanted', 'wrong_amount', 'wrong_payee', 'not_working', 'other')),
	CONSTRAINT "disputes_status" CHECK ("disputes"."status" in ('open', 'upheld', 'rejected')),
	CONSTRAINT "disputes_refund" CHECK ("disputes"."refund" in ('none', 'waiting', 'done')),
	CONSTRAINT "disputes_amount_positive" CHECK ("disputes"."amount" > 0),
	CONSTRAINT "disputes_what" CHECK (("disputes"."kind" = 'payment' and "disputes"."payment_id" is not null and "disputes"."week" is null) or ("disputes"."kind" = 'rent' and "disputes"."payment_id" is null and "disputes"."week" is not null))
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_kind";--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_sign";--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_platform";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disputes" ADD CONSTRAINT "disputes_renter_user_id_users_id_fk" FOREIGN KEY ("renter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disputes" ADD CONSTRAINT "disputes_maker_user_id_users_id_fk" FOREIGN KEY ("maker_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disputes" ADD CONSTRAINT "disputes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disputes" ADD CONSTRAINT "disputes_installation_id_agent_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_installations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_id_agent_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."agent_payments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disputes" ADD CONSTRAINT "disputes_rental_id_rentals_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rentals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disputes_status_idx" ON "disputes" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disputes_renter_idx" ON "disputes" USING btree ("renter_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disputes_agent_idx" ON "disputes" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "disputes_once_payment" ON "disputes" USING btree ("payment_id") WHERE "disputes"."payment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "disputes_once_week" ON "disputes" USING btree ("rental_id","week") WHERE "disputes"."rental_id" is not null;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_kind" CHECK ("ledger_entries"."kind" in ('deposit', 'use_charge', 'maker_earning', 'platform_fee', 'withdrawal', 'withdrawal_reversal', 'refund', 'earning_reversal', 'platform_refund'));--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_sign" CHECK (("ledger_entries"."kind" in ('use_charge', 'withdrawal', 'earning_reversal', 'platform_refund')) = ("ledger_entries"."amount" like '-%'));--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_platform" CHECK (("ledger_entries"."kind" in ('platform_fee', 'platform_refund')) = ("ledger_entries"."user_id" is null));