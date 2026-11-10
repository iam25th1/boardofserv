-- The ledger's refund kinds (migration 0050_disputes): refund (the renter's
-- money back), earning_reversal (the maker's share taken back) and
-- platform_refund (the platform's share given back). A deploy's schema push
-- (drizzle-kit push) doesn't change checks on an existing table: run this
-- once on the database after the first deploy with disputes. Until it has
-- run, upheld rent disputes wait to be refunded (the admin screen says so).
-- Safe to run again.
BEGIN;
ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_kind";
ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_sign";
ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_platform";
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_kind" CHECK ("ledger_entries"."kind" in ('deposit', 'use_charge', 'maker_earning', 'platform_fee', 'withdrawal', 'withdrawal_reversal', 'refund', 'earning_reversal', 'platform_refund'));
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_sign" CHECK (("ledger_entries"."kind" in ('use_charge', 'withdrawal', 'earning_reversal', 'platform_refund')) = ("ledger_entries"."amount" like '-%'));
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_platform" CHECK (("ledger_entries"."kind" in ('platform_fee', 'platform_refund')) = ("ledger_entries"."user_id" is null));
COMMIT;
