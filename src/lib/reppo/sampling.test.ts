// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { fakeReppo, type FakeReppo } from "@/test/fakeReppo";
import { pollDue, submitDue } from "./evals";
import { reppoCycle } from "./cycle";
import { LOOKBACK_MS, reppoSettings, reppoStatus, sampleFinished, submitRoom } from "./sampling";

// Sampling: the first few finished jobs of each new version, then one in
// N, at most so many a week for each agent, never past the site's daily
// credit budget, and quiet when the budget is spent until the next day.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let reppo: FakeReppo;
let owner: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "sample.owner");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.delete(schema.reppoEvals);
  await db.update(schema.agentJobs).set({ reppoSample: "skipped" });
  rt = testRuntime(db);
  reppo = fakeReppo(rt.net);
});

const settings = (o: Partial<ReturnType<typeof reppoSettings>> = {}) => ({ ...reppoSettings({}), ...o });

// A finished job of an installation, now.
async function finished(inst: schema.AgentInstallation, status: "done" | "failed" | "cancelled" = "done", at = rt.now()) {
  const [j] = await db
    .insert(schema.agentJobs)
    .values({ installationId: inst.id, versionId: inst.versionId, ownerUserId: inst.ownerUserId, status, trigger: { kind: "schedule" }, finishedAt: at, createdAt: at, updatedAt: at })
    .returning();
  return j!;
}

const choices = async (ids: string[]) => {
  const rows = await db.select({ id: schema.agentJobs.id, s: schema.agentJobs.reppoSample }).from(schema.agentJobs).where(inArray(schema.agentJobs.id, ids));
  return ids.map((id) => rows.find((r) => r.id === id)!.s);
};

describe("sampling", () => {
  it("takes the first few jobs of a new version, then one in N", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      ids.push((await finished(inst)).id);
      rt.clock.move(1000);
      await sampleFinished(rt, settings({ firstJobs: 2, sampleEvery: 3 }));
    }
    expect(await choices(ids)).toEqual(["sampled", "sampled", "skipped", "skipped", "sampled", "skipped", "skipped", "sampled", "skipped"]);
    expect(await db.select().from(schema.reppoEvals)).toHaveLength(4);
  });

  it("starts again with each new version", async () => {
    const p = await publishedAgent(db, owner);
    const inst = await installed(rt, owner, p);
    for (let i = 0; i < 2; i++) await finished(inst);
    await sampleFinished(rt, settings({ firstJobs: 1, sampleEvery: 100 }));
    const [v2] = await db.insert(schema.agentVersions).values({ agentId: p.agent.id, number: 2, state: "published", publishedAt: rt.now(), definition: p.version.definition, code: p.version.code, bench: p.version.bench }).returning();
    await db.update(schema.agentInstallations).set({ versionId: v2!.id }).where(eq(schema.agentInstallations.id, inst.id));
    const next = await finished({ ...inst, versionId: v2!.id });
    await sampleFinished(rt, settings({ firstJobs: 1, sampleEvery: 100 }));
    expect(await choices([next.id])).toEqual(["sampled"]);
  });

  it("keeps to a weekly cap for each agent, free example agents too, and starts again on Monday", async () => {
    // A free agent on the board, as the examples are.
    const p = await publishedAgent(db, owner);
    await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: "0", jobFee: "0", listed: true });
    const inst = await installed(rt, owner, p);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await finished(inst)).id);
    await sampleFinished(rt, settings({ firstJobs: 10, weeklyPerAgent: 2 }));
    expect(await choices(ids)).toEqual(["sampled", "sampled", "cap", "cap"]);
    rt.clock.move(7 * 24 * 60 * 60_000);
    const later = await finished(inst);
    await sampleFinished(rt, settings({ firstJobs: 10, weeklyPerAgent: 2 }));
    expect(await choices([later.id])).toEqual(["sampled"]);
  });

  it("stops quietly when the day's credits are spoken for, and starts again the next day", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await finished(inst)).id);
    const s = settings({ firstJobs: 10, dailyCredits: 880 });
    await sampleFinished(rt, s);
    expect(await choices(ids)).toEqual(["sampled", "sampled", "budget"]);
    expect((await reppoStatus(rt, s)).budgetSpent).toBe(true);
    // Submitting keeps within it too: two go, then the day is full.
    reppo.readsToFinish = 1;
    expect(await submitDue(rt, { room: (r, row) => submitRoom(r, row, s) })).toBe(2);
    rt.clock.move(31_000);
    await pollDue(rt);
    expect(await reppoStatus(rt, s)).toMatchObject({ today: { credits: 880, evals: 2 }, week: { credits: 880, evals: 2 }, inFlight: 0, queued: 0 });
    // The next UTC day there is room again.
    rt.clock.move(24 * 60 * 60_000);
    const tomorrow = await finished(inst);
    await sampleFinished(rt, s);
    expect(await choices([tomorrow.id])).toEqual(["sampled"]);
    expect((await reppoStatus(rt, s)).budgetSpent).toBe(false);
  });

  it("leaves running, waiting, cancelled and old jobs alone, and looks at each job once", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const cancelled = await finished(inst, "cancelled");
    const old = await finished(inst, "done", new Date(rt.now().getTime() - LOOKBACK_MS - 60_000));
    const failed = await finished(inst, "failed");
    expect(await sampleFinished(rt, settings())).toBe(1);
    expect(await choices([cancelled.id, old.id, failed.id])).toEqual([null, null, "sampled"]);
    expect(await sampleFinished(rt, settings())).toBe(0);
  });

  it("runs as part of the cycle: sample, submit within budget, read back", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    await finished(inst);
    reppo.readsToFinish = 1;
    await reppoCycle(rt);
    expect(reppo.submitted).toHaveLength(1);
    rt.clock.move(31_000);
    await reppoCycle(rt);
    const [row] = await db.select().from(schema.reppoEvals);
    expect(row).toMatchObject({ kind: "job", status: "completed", score: 82, route: "ship" });
  });
});
