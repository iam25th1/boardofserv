-- The audit log's append-only trigger (migration 0042_audit_log). A deploy's
-- schema push (drizzle-kit push) makes the table but not this trigger: run
-- this once on the database after the first deploy with the audit log.
-- Safe to run again.
CREATE OR REPLACE FUNCTION agent_audit_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'agent_audit is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_audit_append_only ON "agent_audit";
CREATE TRIGGER agent_audit_append_only BEFORE UPDATE OR DELETE ON "agent_audit" FOR EACH STATEMENT EXECUTE FUNCTION agent_audit_append_only();
