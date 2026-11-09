// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, sheetRows, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { claimJob, enqueue, runJob } from "@/lib/agents/runtime/jobs";
import { control, ControlRefused, loadInstallation } from "@/lib/agents/runtime/installations";
import { boardAgents } from "@/lib/market/listings";
import { makeOffer, postRequest, RequestRefused } from "@/lib/market/requests";
import { renewDue, rent, RentRefused, WEEK_MS } from "@/lib/market/rentals";
import { freeze, frozenText, lift, startEverywhere, STARTED_AGAIN, stopEverywhere, STOPPED_EVERYWHERE } from "./freeze";

// Stopping things: the maker's kill switch, an admin's freezes, and the
// renter's pause in the middle of a job.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let admin: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "freeze.maker");
  admin = await addUser(db, "freeze.admin");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(eq(schema.agentJobs.status, "queued"));
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
});

const instOf = async (id: string) => (await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, id)))[0]!;
async function onBoard() {
  const p = await publishedAgent(db, maker);
  await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: "0" });
  return p;
}
async function renting(p: { agent: schema.Agent; version: schema.AgentVersion }) {
  const renter = await addUser(db, `freeze.renter.${Math.random().toString(36).slice(2, 8)}`);
  const r = await rent(rt, { renterUserId: renter.id, agentId: p.agent.id });
  const inst = await installed(rt, renter, p);
  await db.update(schema.rentals).set({ installationId: inst.id }).where(eq(schema.rentals.id, r.id));
  await control(rt, (await loadInstallation(rt, inst.id))!, "golive").catch(() => undefined);
  return { renter, r, inst };
}

describe("the kill switch", () => {
  it("pauses every copy, tells each renter, holds renewals and new rentals, then starts again with the time given back", async () => {
    const p = await onBoard();
    const a = await renting(p);
    const b = await renting(p);
    // B paused it themselves: starting again leaves that alone.
    await control(rt, (await loadInstallation(rt, b.inst.id))!, "pause");
    expect(await stopEverywhere(rt, p.agent, "A supplier changed its page; fixing it.")).toBe(1);
    expect(await instOf(a.inst.id)).toMatchObject({ status: "paused", pausedReason: STOPPED_EVERYWHERE });
    const [told] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, a.inst.id));
    expect(told).toMatchObject({ from: "agent", tgState: "pending", text: `${STOPPED_EVERYWHERE} Its maker says: "A supplier changed its page; fixing it."` });
    // Nothing new: no rental, no place on the board, no resume.
    await expect(rent(rt, { renterUserId: (await addUser(db, "freeze.late")).id, agentId: p.agent.id })).rejects.toBeInstanceOf(RentRefused);
    expect((await boardAgents(rt)).map((x) => x.id)).not.toContain(p.agent.id);
    await expect(control(rt, (await loadInstallation(rt, a.inst.id))!, "resume")).rejects.toThrow(new ControlRefused(STOPPED_EVERYWHERE));
    // A job queued for a paused copy isn't picked up; one that slips through
    // (its copy paused just after) is turned away when it starts.
    const job = await enqueue(rt, a.inst, { kind: "manual" });
    expect(await claimJob(rt, "w")).toBeNull();
    await db.update(schema.agentInstallations).set({ status: "active" }).where(eq(schema.agentInstallations.id, a.inst.id));
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    expect((await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id)))[0]).toMatchObject({ status: "cancelled", reason: STOPPED_EVERYWHERE });
    expect((await instOf(a.inst.id)).status).toBe("paused");
    // Renewals wait.
    const paidUntil = (await db.select().from(schema.rentals).where(eq(schema.rentals.id, a.r.id)))[0]!.paidUntil;
    rt.clock.move(WEEK_MS + 3_600_000);
    await renewDue(rt);
    expect((await db.select().from(schema.rentals).where(eq(schema.rentals.id, a.r.id)))[0]).toMatchObject({ status: "active", weeksPaid: 1 });
    // Started again: copies it paused resume, and the stopped time is added back.
    expect(await startEverywhere(rt, p.agent)).toBe(1);
    expect((await instOf(a.inst.id)).status).toBe("active");
    expect((await instOf(b.inst.id)).status).toBe("paused");
    const after = (await db.select().from(schema.rentals).where(eq(schema.rentals.id, a.r.id)))[0]!.paidUntil;
    expect(after.getTime() - paidUntil.getTime()).toBe(WEEK_MS + 3_600_000);
    const messages = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, a.inst.id));
    expect(messages.map((m) => m.text)).toContain(STARTED_AGAIN(p.agent.name));
  });
});

describe("freezes", () => {
  it("freeze an agent: nothing runs, it can't be rented, offered or seen, and lifting starts it again", async () => {
    const p = await onBoard();
    const a = await renting(p);
    const f = await freeze(rt, admin, "agent", p.agent.id, "Reported for scraping without permission.");
    expect(await instOf(a.inst.id)).toMatchObject({ status: "paused", pausedReason: frozenText("Reported for scraping without permission.") });
    await expect(rent(rt, { renterUserId: (await addUser(db, "freeze.late2")).id, agentId: p.agent.id })).rejects.toThrow(/boardofserv froze it: Reported for scraping/);
    const asker = await addUser(db, "freeze.asker");
    const q = await postRequest(rt, asker.id, { need: "Watch prices", detail: "", connects: [], budget: null });
    await expect(makeOffer(rt, maker.id, q.id, { agentId: p.agent.id, note: "", weeklyPrice: 0n, jobFee: 0n })).rejects.toBeInstanceOf(RequestRefused);
    expect((await boardAgents(rt)).map((x) => x.id)).not.toContain(p.agent.id);
    await lift(rt, admin, f.id, "Checked: it has permission.");
    expect((await instOf(a.inst.id)).status).toBe("active");
    expect((await db.select().from(schema.freezes).where(eq(schema.freezes.id, f.id)))[0]).toMatchObject({ liftReason: "Checked: it has permission.", liftedBy: admin.id });
    expect(await lift(rt, admin, f.id, "Again.")).toBeNull();
  });

  it("freeze a renter: their copies pause and they can't rent", async () => {
    const p = await onBoard();
    const a = await renting(p);
    await freeze(rt, admin, "renter", a.renter.id, "Chargeback.");
    expect((await instOf(a.inst.id)).status).toBe("paused");
    const other = await onBoard();
    await expect(rent(rt, { renterUserId: a.renter.id, agentId: other.agent.id })).rejects.toThrow(/boardofserv froze this account: Chargeback\./);
  });

  it("freeze a maker or a version: what runs on it pauses, and the maker can't offer", async () => {
    const m = await addUser(db, "freeze.maker2");
    const p = await publishedAgent(db, m);
    await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: "0" });
    const a = await renting(p);
    await freeze(rt, admin, "version", p.version.id, "This version leaks order totals.");
    expect((await instOf(a.inst.id)).pausedReason).toBe(frozenText("This version leaks order totals."));
    expect((await boardAgents(rt)).map((x) => x.id)).not.toContain(p.agent.id);
    await freeze(rt, admin, "maker", m.id, "Too many scam reports.");
    const asker = await addUser(db, "freeze.asker2");
    const q = await postRequest(rt, asker.id, { need: "Count sign-ups", detail: "", connects: [], budget: null });
    await expect(makeOffer(rt, m.id, q.id, { agentId: p.agent.id, note: "", weeklyPrice: 0n, jobFee: 0n })).rejects.toThrow(/can't be offered now/);
    const active = await db.select().from(schema.freezes).where(and(eq(schema.freezes.targetId, m.id)));
    expect(active).toHaveLength(1);
  });
});

describe("the renter's pause", () => {
  it("lets the step running now finish and runs nothing after it", async () => {
    const owner = await addUser(db, "freeze.pauser");
    const inst = await installed(rt, owner, await publishedAgent(db, maker));
    // The renter pauses while SERV is deciding.
    rt.serve = (ids) => {
      void db.update(schema.agentInstallations).set({ status: "paused", pausedReason: null }).where(eq(schema.agentInstallations.id, inst.id)).execute();
      return ids.includes("within") ? "within" : ids[0]!;
    };
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    const [j] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
    expect(j).toMatchObject({ status: "cancelled", reason: "Paused by you: it stopped after the step it was on." });
    const steps = await db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, job.id));
    expect(steps.map((s) => s.stepId)).toContain("check_total");
    expect(steps.map((s) => s.stepId)).not.toContain("record");
    expect(sheetRows(rt, inst, "orders_sheet")).toEqual([]);
  });
});
