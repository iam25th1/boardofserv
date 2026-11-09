CREATE TABLE IF NOT EXISTS "agent_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"installation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"job_id" uuid,
	"step" text NOT NULL,
	"tool" text NOT NULL,
	"risk" text NOT NULL,
	"what" text NOT NULL,
	"outcome" text NOT NULL,
	"guard" text,
	"guard_reason" text,
	"reason" text,
	"approved_by" text,
	"cost" numeric(78, 0) DEFAULT '0' NOT NULL,
	"spent" numeric(20, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_audit_seq_idx" ON "agent_audit" USING btree ("seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_audit_installation_idx" ON "agent_audit" USING btree ("installation_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_audit_agent_idx" ON "agent_audit" USING btree ("agent_id","seq");--> statement-breakpoint
-- The audit log is append-only in the database too: no row is changed or removed.
CREATE OR REPLACE FUNCTION agent_audit_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'agent_audit is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_audit_append_only ON "agent_audit";--> statement-breakpoint
CREATE TRIGGER agent_audit_append_only BEFORE UPDATE OR DELETE ON "agent_audit" FOR EACH STATEMENT EXECUTE FUNCTION agent_audit_append_only();
