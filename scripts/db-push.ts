import { spawnSync } from "node:child_process";
import pg from "pg";
import { CONNECTION_PROVIDERS } from "../src/lib/db/schema";

// The schema push a deploy runs (pier.json: npm run db:push:deploy), where
// nobody can answer drizzle-kit's questions. drizzle-kit applies an additive
// change by itself; for anything that would lose data, or a rename it can't
// tell from a drop and an add, it asks, and with no terminal it gives up and
// changes nothing: drizzle-kit 0.28 still exited 0, 0.31 says "Interactive
// prompts require a TTY" and exits 1. The deploy would then start the new
// code on the old schema. This fails the deploy instead, before the restart,
// so the change can be made by hand first (docs/DEPLOY-PIER.md).

export type PushVerdict = { ok: true } | { ok: false; reason: string };

export function pushVerdict(status: number | null, output: string): PushVerdict {
  if (/data-loss|❯|Interactive prompts require a TTY/.test(output)) {
    return {
      ok: false,
      reason: "drizzle-kit push stopped at a question (data loss, or a rename it can't tell apart) and changed nothing. Make the change by hand, then deploy again (docs/DEPLOY-PIER.md).",
    };
  }
  if (status !== 0) return { ok: false, reason: `drizzle-kit push exited ${status ?? "on a signal"}.` };
  if (/No changes detected|Changes applied/.test(output)) return { ok: true };
  return { ok: false, reason: "drizzle-kit push did not say it applied the schema." };
}

// Check constraints drizzle-kit push leaves as they are once a table has
// one (rehearsed: a check with a new value pushes as "No changes detected").
// After the push, each one the database holds differently is put right:
// dropped and made again, in one statement. Its values are the schema's.
export interface SyncedCheck {
  table: string;
  name: string;
  column: string;
  values: readonly string[];
}

export const SYNCED_CHECKS: SyncedCheck[] = [{ table: "connections", name: "connections_provider", column: "provider", values: CONNECTION_PROVIDERS }];

// Whether the database's definition of the check allows exactly these values.
export function checkMatches(definition: string | null, values: readonly string[]): boolean {
  if (!definition) return false;
  const found = [...definition.matchAll(/'([^']*)'/g)].map((m) => m[1]!).sort();
  return found.length === values.length && [...values].sort().every((v, i) => v === found[i]);
}

export function checkSql(c: SyncedCheck): string {
  const values = c.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
  return `ALTER TABLE "${c.table}" DROP CONSTRAINT IF EXISTS "${c.name}", ADD CONSTRAINT "${c.name}" CHECK ("${c.column}" in (${values}))`;
}

async function syncChecks(url: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const changed: string[] = [];
  try {
    for (const c of SYNCED_CHECKS) {
      const { rows } = await client.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1", [c.name]);
      if (checkMatches(rows[0]?.def ?? null, c.values)) continue;
      await client.query(checkSql(c));
      changed.push(c.name);
    }
  } finally {
    await client.end();
  }
  return changed;
}

// Run when started by npm run db:push:deploy, not when a test imports it.
if (!process.env.VITEST) {
  const r = spawnSync("drizzle-kit", ["push"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  const verdict = pushVerdict(r.status, `${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!verdict.ok) {
    console.error(`db:push:deploy: ${verdict.reason}`);
    process.exit(1);
  }
  // The same database drizzle-kit pushed to (drizzle.config.ts).
  const url = process.env.DATABASE_URL ?? "postgres://boardofserv:boardofserv@localhost:5433/boardofserv";
  try {
    const changed = await syncChecks(url);
    console.log(changed.length ? `db:push:deploy: checks put right: ${changed.join(", ")}` : "db:push:deploy: checks already right");
  } catch (err) {
    console.error(`db:push:deploy: the checks couldn't be put right: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exit(1);
  }
}
