// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { Runtime } from "./context";
import { claimJob, enqueue } from "./jobs";
import { installed, publishedAgent, testRuntime } from "@/test/runtimeFixtures";

// Two workers on two real connections claiming at once, on a real Postgres
// (PGlite has one session, so it can't show a race): every job is claimed
// exactly once, and never two of one installation running together. CI
// runs a Postgres for this (ci.yml); locally, point TEST_POSTGRES_URL at a
// scratch server. It makes a database of its own and drops it after.

const URL = process.env.TEST_POSTGRES_URL;
if (process.env.CI && !URL) throw new Error("TEST_POSTGRES_URL must be set in CI: claiming jobs needs a real Postgres.");

describe.skipIf(!URL)("claiming jobs, on a real Postgres", () => {
  const name = `bos_claim_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let admin: pg.Client;
  let a: pg.Pool;
  let b: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const url = new globalThis.URL(URL!);
    url.pathname = `/${name}`;
    a = new pg.Pool({ connectionString: url.toString(), max: 4 });
    b = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await migrate(drizzle(a, { schema }), { migrationsFolder: join(__dirname, "../../db/migrations") });
  });
  afterAll(async () => {
    await a.end();
    await b.end();
    await admin.query(`drop database if exists ${name}`);
    await admin.end();
  });

  it("claims every job exactly once, one running per installation", async () => {
    const dbA = drizzle(a, { schema });
    const dbB = drizzle(b, { schema });
    const rtA: Runtime = { ...testRuntime(dbA as never), now: () => new Date() };
    const rtB: Runtime = { ...rtA, db: dbB as unknown as Runtime["db"] };
    const [owner] = await dbA.insert(schema.users).values({ privyUserId: "did:privy:owner", handle: "owner" }).returning();
    const p = await publishedAgent(dbA as never, owner!);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const inst = await installed(rtA, owner!, p);
      for (let j = 0; j < 3; j++) ids.push((await enqueue(rtA, inst, { kind: "manual" })).id);
    }
    const claimed: { id: string; by: string }[] = [];
    let overlap = 0;
    const work = async (rt: Runtime, by: string) => {
      for (let idle = 0; idle < 30; ) {
        const job = await claimJob(rt, by);
        if (!job) {
          idle += 1;
          await new Promise((r) => setTimeout(r, 5));
          continue;
        }
        claimed.push({ id: job.id, by });
        const { rows } = await a.query("select count(*)::int as n from agent_jobs where installation_id = $1 and status = 'running'", [job.installationId]);
        if (rows[0].n > 1) overlap += 1;
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        await rt.db.update(schema.agentJobs).set({ status: "done" }).where(and(eq(schema.agentJobs.id, job.id), eq(schema.agentJobs.claimedBy, by)));
      }
    };
    await Promise.all([work(rtA, "a1"), work(rtB, "b1"), work(rtA, "a2"), work(rtB, "b2")]);
    expect(overlap).toBe(0);
    expect(claimed.map((c) => c.id).sort()).toEqual([...ids].sort());
    expect(new Set(claimed.map((c) => c.id)).size).toBe(ids.length);
    // Both connections did some of the work.
    expect(new Set(claimed.map((c) => c.by[0])).size).toBe(2);
  }, 60_000);
});
