// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { audit } from "@/lib/agents/audit";
import { freeze } from "@/lib/safety/freeze";
import { agentPage } from "@/lib/market/listings";
import { makerDashboard } from "@/lib/market/dashboard";
import { makerSignals, versionSignals } from "./signals";
import { makerTrust, refreshMaker, refreshTrust, refreshVersion, trustTrend, versionTrust } from "./trust";

// Trust scores from what happened: jobs, blocks, Reppo, reports, freezes,
// holds, age, renewals and payments, for a version and for its maker;
// stored with their factors, refreshed after jobs and daily, with a trend.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let renter: schema.User;
let n = 0;

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "trust.maker", "trust_maker");
  renter = await addUser(db, "trust.renter", "trust_renter");
});
afterAll(async () => client.close());
beforeEach(() => {
  rt = testRuntime(db);
});

async function agent() {
  const p = await publishedAgent(db, maker);
  await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: "0", jobFee: "0", listed: true });
  const inst = await installed(rt, renter, p);
  return { ...p, inst };
}

async function jobs(p: { version: schema.AgentVersion; inst: schema.AgentInstallation }, done: number, failed: number, daysAgo = 1) {
  const at = new Date(rt.now().getTime() - daysAgo * 86_400_000);
  for (const [status, count] of [["done", done], ["failed", failed]] as const) {
    for (let i = 0; i < count; i++) {
      await db.insert(schema.agentJobs).values({ installationId: p.inst.id, versionId: p.version.id, ownerUserId: renter.id, status, trigger: { kind: "schedule" }, finishedAt: at, createdAt: at, updatedAt: at, reppoSample: "skipped" });
    }
  }
}

describe("trust signals", () => {
  it("count a version's jobs, blocks, Reppo scores, reports, freezes, holds, renewals and payments", async () => {
    const p = await agent();
    await jobs(p, 18, 2);
    await jobs(p, 5, 5, 200); // outside the window
    const [v] = await db.select().from(schema.agentJobs).where(eqVersion(p.version.id)).limit(1);
    await audit(rt, { installationId: p.inst.id, agentId: p.agent.id, ownerUserId: renter.id, jobId: v!.id, step: "Pay", tool: "wallet.pay", risk: "money", what: "x", outcome: "blocked", cost: "0" });
    // A block 40 days ago is outside the recent window.
    rt.clock.move(-40 * 86_400_000);
    await audit(rt, { installationId: p.inst.id, agentId: p.agent.id, ownerUserId: renter.id, jobId: v!.id, step: "Pay", tool: "wallet.pay", risk: "money", what: "x", outcome: "blocked", cost: "0" });
    rt.clock.move(40 * 86_400_000);
    for (const [score, route] of [[90, "ship"], [80, "ship"], [40, "block"]] as const) {
      await db.insert(schema.reppoEvals).values({ kind: "job", key: `job:trust-${++n}`, agentId: p.agent.id, versionId: p.version.id, installationId: p.inst.id, taskType: "action", input: "x", status: "completed", score, route, completedAt: rt.now() });
    }
    await db.insert(schema.reports).values({ kind: "agent", targetId: p.agent.id, reporterUserId: renter.id, reason: "scam", note: "", status: "resolved", resolution: "Hidden: payments outside the site.", resolvedAt: rt.now() });
    await freeze(rt, maker, "agent", p.agent.id, "Checking.");
    await db.update(schema.agentListings).set({ screen: "held" }).where(eqAgentListing(p.agent.id));
    await db.insert(schema.rentals).values({ agentId: p.agent.id, versionId: p.version.id, renterUserId: renter.id, makerUserId: maker.id, weeklyPrice: "1000000", paidUntil: rt.now(), weeksPaid: 5, updatedAt: rt.now() });
    await db.insert(schema.rentals).values({ agentId: p.agent.id, versionId: p.version.id, renterUserId: renter.id, makerUserId: maker.id, weeklyPrice: "1000000", paidUntil: rt.now(), weeksPaid: 1, renews: false, cancelledAt: rt.now(), updatedAt: rt.now() });
    const s = (await versionSignals(rt, p.version.id))!;
    expect(s).toMatchObject({ done: 18, failed: 2, blocks: 1, reppoAvg: 70, reppoReviewed: 3, reppoBlocks: 1, reportsUpheld: 1, freezes: 1, frozenNow: true, heldNow: true, renewals: 4, cancellations: 1 });
    const score = (await refreshVersion(rt, p.version.id))!;
    expect(score.factors.map((f) => f.key).sort()).toEqual(["blocks", "cancellations", "freezes", "frozenNow", "heldNow", "jobs", "renewals", "reports", "reppoBlocks"].sort());
    expect((await versionTrust(rt, [p.version.id])).get(p.version.id)).toMatchObject({ score: score.score, label: score.label, isNew: false });
  });

  it("give a maker everything about all of their agents, and their own reports and freezes", async () => {
    const own = await addUser(db, "trust.solo", "trust_solo");
    const a = await publishedAgent(db, own);
    const b = await publishedAgent(db, own);
    const ia = await installed(rt, renter, a);
    const ib = await installed(rt, renter, b);
    await jobs({ version: a.version, inst: ia }, 8, 0);
    await jobs({ version: b.version, inst: ib }, 8, 4);
    await freeze(rt, maker, "maker", own.id, "Reported for spam.");
    const s = (await makerSignals(rt, own.id))!;
    expect(s).toMatchObject({ done: 16, failed: 4, freezes: 1, frozenNow: true });
    const score = (await refreshMaker(rt, own.id))!;
    expect((await makerTrust(rt, own.id)).score).toBe(score.score);
    expect(score.factors.find((f) => f.key === "frozenNow")).toBeTruthy();
  });
});

describe("trust scores kept", () => {
  it("start new for a version with no score yet, and are refreshed once its jobs finish, with its maker", async () => {
    const p = await agent();
    expect((await versionTrust(rt, [p.version.id])).get(p.version.id)).toMatchObject({ score: 600, label: "new", isNew: true });
    await jobs(p, 12, 0);
    expect(await refreshTrust(rt, 200)).toBeGreaterThan(0);
    const t = (await versionTrust(rt, [p.version.id])).get(p.version.id)!;
    expect(t.isNew).toBe(false);
    expect(t.factors[0]).toMatchObject({ key: "jobs", words: "12 of 12 jobs finished in the last 90 days (100%)" });
    expect((await makerTrust(rt, maker.id)).computedAt).not.toBeNull();
    // Nothing new: nothing to refresh for it until tomorrow.
    const again = await refreshTrust(rt, 200);
    expect(again).toBe(0);
  });

  it("keep a score a day for the trend, and show on the agent's page and its maker's dashboard", async () => {
    const p = await agent();
    await jobs(p, 12, 0);
    await refreshVersion(rt, p.version.id);
    rt.clock.move(86_400_000);
    await jobs(p, 0, 6);
    await refreshVersion(rt, p.version.id);
    const t = await trustTrend(rt, "version", p.version.id);
    expect(t).toHaveLength(2);
    expect(t[1]!.score).toBeLessThan(t[0]!.score);
    expect((await agentPage(rt, p.agent.id))!.trust.score).toBe(t[1]!.score);
    const d = await makerDashboard(rt, p.agent);
    expect(d.trust.version?.score).toBe(t[1]!.score);
    expect(d.trust.versionTrend).toHaveLength(2);
  });
});

import { eq } from "drizzle-orm";
const eqVersion = (id: string) => eq(schema.agentJobs.versionId, id);
const eqAgentListing = (id: string) => eq(schema.agentListings.agentId, id);
