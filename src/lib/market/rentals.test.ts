// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { linkConnections, ownSheet, publishedAgent, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { balancesOf, ledgerTotal, post } from "@/lib/payments/ledger";
import { claimJob, enqueue, runJob } from "@/lib/agents/runtime/jobs";
import { control, ControlRefused, loadInstallation } from "@/lib/agents/runtime/installations";
import { FEE_SHORT, holdJobFee, settleJobFees } from "./charges";
import { installRental, RENT_SHORT, rent, rentalControl, rentalDetail, rentalDTOs, rentalOf, rentalsOf, renewDue, RentRefused, rentalSetup, WEEK_MS } from "./rentals";

// Renting through the ledger on the real migrations: the first week paid
// at once (90% to the maker, 10% to the platform), renewed each week while
// the balance covers it, paused when it doesn't, cancelled to the end of
// the paid week; fees per job held before the job and settled after.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;

const usdc = (whole: number) => BigInt(Math.round(whole * 1e6));
const exec = () => db as never;

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
  maker = await addUser(db, "rent.maker", "maya_r");
});
afterAll(async () => client.close());

let funded = 0;
async function renter(handle: string, balance: number): Promise<schema.User> {
  const u = await addUser(db, handle);
  if (balance > 0) await post(exec(), { userId: u.id, currency: "USDC", kind: "deposit", amount: usdc(balance), key: `fund:${u.id}:${++funded}` });
  return u;
}
const topUp = (u: schema.User, amount: number) => post(exec(), { userId: u.id, currency: "USDC", kind: "deposit", amount: usdc(amount), key: `topup:${u.id}:${++funded}` });

async function listed(weekly: number, jobFee = 0) {
  const p = await publishedAgent(db, maker);
  await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: usdc(weekly).toString(), jobFee: usdc(jobFee).toString() });
  return p;
}

const available = async (u: schema.User | string) => (await balancesOf(typeof u === "string" ? u : u.id, exec())).USDC;

async function setUp(r: schema.Rental, owner: schema.User) {
  await linkConnections(rt, owner);
  const sheet = ownSheet(rt);
  const id = await installRental(rt, r, {
    settings: { stock_sheet: sheet.answer("Stock"), orders_sheet: sheet.answer("Orders"), suppliers_sheet: sheet.answer("Suppliers") },
    rules: {},
    timezone: "UTC",
    minGapMinutes: 0,
  });
  const l = (await loadInstallation(rt, id))!;
  await control(rt, l, "golive");
  return id;
}
const fresh = async (r: schema.Rental) => (await db.select().from(schema.rentals).where(eq(schema.rentals.id, r.id)))[0]!;
const installation = async (id: string) => (await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, id)))[0]!;

describe("renting an agent", () => {
  it("charges the first week through the ledger: 90 to the maker, 10 to the platform", async () => {
    const p = await listed(10);
    const sam = await renter("renter.sam", 25);
    const makerBefore = (await available(maker)).available;
    const platformBefore = await ledgerTotal(null, "USDC", exec());
    const r = await rent(rt, { renterUserId: sam.id, agentId: p.agent.id });
    expect(r).toMatchObject({ status: "active", weeksPaid: 1, renews: true, renterUserId: sam.id, makerUserId: maker.id, weeklyPrice: usdc(10).toString() });
    expect(r.paidUntil.getTime() - rt.now().getTime()).toBe(WEEK_MS);
    expect(await available(sam)).toEqual({ available: usdc(15), held: 0n });
    expect((await available(maker)).available - makerBefore).toBe(usdc(9));
    expect((await ledgerTotal(null, "USDC", exec())) - platformBefore).toBe(usdc(1));
    const [hold] = await db.select().from(schema.holds).where(and(eq(schema.holds.userId, sam.id), eq(schema.holds.kind, "rent")));
    expect(hold).toMatchObject({ status: "captured", amount: usdc(10).toString(), makerUserId: maker.id });
    expect(await db.select().from(schema.rentalCharges).where(eq(schema.rentalCharges.rentalId, r.id))).toEqual([expect.objectContaining({ week: 1, holdId: hold!.id })]);
    // The ledger adds up to what the renter holds.
    expect(await ledgerTotal(sam.id, "USDC", exec())).toBe(usdc(15));
  });

  it("refuses its own maker, a second rental and a balance that doesn't cover the week, changing nothing", async () => {
    const p = await listed(10);
    await expect(rent(rt, { renterUserId: maker.id, agentId: p.agent.id })).rejects.toMatchObject({ status: 409 });
    const poor = await renter("renter.poor", 4);
    const refused = await rent(rt, { renterUserId: poor.id, agentId: p.agent.id }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RentRefused);
    expect(refused).toMatchObject({ status: 402, message: "The first week is 10.00 USDC, and your balance doesn't cover it. Top up your wallet, then rent it." });
    expect(await available(poor)).toEqual({ available: usdc(4), held: 0n });
    expect(await db.select().from(schema.rentals).where(eq(schema.rentals.renterUserId, poor.id))).toEqual([]);
    const rich = await renter("renter.rich", 50);
    await rent(rt, { renterUserId: rich.id, agentId: p.agent.id });
    await expect(rent(rt, { renterUserId: rich.id, agentId: p.agent.id })).rejects.toMatchObject({ status: 409 });
    // Off the board, or no such agent.
    await db.update(schema.agentListings).set({ listed: false }).where(eq(schema.agentListings.agentId, p.agent.id));
    await expect(rent(rt, { renterUserId: (await renter("renter.late", 50)).id, agentId: p.agent.id })).rejects.toMatchObject({ status: 404 });
    await expect(rent(rt, { renterUserId: rich.id, agentId: "nope" })).rejects.toMatchObject({ status: 404 });
  });

  it("rents a free agent with no money moving", async () => {
    const p = await listed(0);
    const kim = await renter("renter.kim", 0);
    const r = await rent(rt, { renterUserId: kim.id, agentId: p.agent.id });
    expect(await db.select().from(schema.rentalCharges).where(eq(schema.rentalCharges.rentalId, r.id))).toEqual([expect.objectContaining({ week: 1, amount: "0", holdId: null })]);
    expect(await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.userId, kim.id))).toEqual([]);
  });

  it("is set up by the renter, as its owner, from only what setting it up needs", async () => {
    const p = await listed(3);
    const lee = await renter("renter.lee", 10);
    const r = await rent(rt, { renterUserId: lee.id, agentId: p.agent.id });
    const setup = (await rentalSetup(rt, r))!;
    expect(Object.keys(setup).sort()).toEqual(["name", "needs", "rules", "settings", "triggers"]);
    const shown = JSON.stringify(setup);
    for (const s of restockDefinition().steps) {
      if (s.kind === "code") expect(shown).not.toContain(s.description);
      if (s.kind === "decision") expect(shown).not.toContain(s.prompt);
    }
    expect((await rentalDTOs(rt, [r]))[0]).toMatchObject({ status: "setup", installationId: null, maker: "maya_r" });
    const id = await setUp(r, lee);
    expect(await installation(id)).toMatchObject({ ownerUserId: lee.id, agentId: p.agent.id, versionId: p.version.id, live: true });
    expect((await rentalDTOs(rt, [await fresh(r)]))[0]).toMatchObject({ status: "active", installationId: id });
    // Only its renter sees it.
    expect(await rentalOf(rt, maker.id, r.id)).toBeNull();
  });
});

describe("each week", () => {
  it("renews while the balance covers it, and pauses with a plain message when it doesn't", async () => {
    const p = await listed(4);
    const ana = await renter("renter.ana", 9);
    const r = await rent(rt, { renterUserId: ana.id, agentId: p.agent.id });
    const id = await setUp(r, ana);
    // Not before the paid week is over.
    expect(await renewDue(rt)).toBe(0);
    rt.clock.move(WEEK_MS);
    expect(await renewDue(rt)).toBeGreaterThanOrEqual(1);
    let row = await fresh(r);
    expect(row).toMatchObject({ status: "active", weeksPaid: 2 });
    expect(row.paidUntil.getTime()).toBe(r.paidUntil.getTime() + WEEK_MS);
    expect((await available(ana)).available).toBe(usdc(1));
    // A cycle that runs again changes nothing.
    await renewDue(rt);
    expect((await fresh(r)).weeksPaid).toBe(2);

    rt.clock.move(WEEK_MS);
    await renewDue(rt);
    row = await fresh(r);
    expect(row).toMatchObject({ status: "unpaid", weeksPaid: 2 });
    expect(await installation(id)).toMatchObject({ status: "paused", pausedReason: RENT_SHORT(usdc(4).toString()) });
    expect(RENT_SHORT(usdc(4).toString())).toBe("This week's rent of 4.00 USDC couldn't be paid: your balance is too low. Top up your wallet, then resume it from Rented.");
    expect((await rentalDTOs(rt, [row]))[0]!.status).toBe("unpaid");
    // Its own resume is refused: the rental's resume pays the week.
    await expect(control(rt, (await loadInstallation(rt, id))!, "resume")).rejects.toBeInstanceOf(ControlRefused);
    await expect(rentalControl(rt, row, "resume")).rejects.toMatchObject({ status: 402 });

    await topUp(ana, 5);
    await rentalControl(rt, row, "resume");
    row = await fresh(r);
    expect(row).toMatchObject({ status: "active", weeksPaid: 3 });
    expect(row.paidUntil.getTime()).toBe(rt.now().getTime() + WEEK_MS);
    expect(await installation(id)).toMatchObject({ status: "active", pausedReason: null });
    expect((await available(ana)).available).toBe(usdc(2));
    expect(await db.select().from(schema.rentalCharges).where(eq(schema.rentalCharges.rentalId, r.id))).toHaveLength(3);
  });

  it("stops at the end of the paid week once cancelled, and can be renewed before then", async () => {
    const p = await listed(2);
    const bo = await renter("renter.bo", 20);
    const r = await rent(rt, { renterUserId: bo.id, agentId: p.agent.id });
    const id = await setUp(r, bo);
    await rentalControl(rt, r, "cancel");
    expect((await rentalDTOs(rt, [await fresh(r)]))[0]!.status).toBe("cancelling");
    await expect(rentalControl(rt, await fresh(r), "cancel")).rejects.toMatchObject({ status: 409 });
    await rentalControl(rt, await fresh(r), "renew");
    expect((await fresh(r)).renews).toBe(true);
    await rentalControl(rt, await fresh(r), "cancel");
    // Still running for the rest of the week.
    expect((await installation(id)).status).toBe("active");
    rt.clock.move(WEEK_MS);
    await renewDue(rt);
    expect(await fresh(r)).toMatchObject({ status: "ended", weeksPaid: 1 });
    expect((await installation(id)).status).toBe("stopped");
    expect((await available(bo)).available).toBe(usdc(18));
    await expect(rentalControl(rt, await fresh(r), "resume")).rejects.toMatchObject({ status: 409 });
    // Ended, it can be rented again.
    expect((await rent(rt, { renterUserId: bo.id, agentId: p.agent.id })).status).toBe("active");
  });

  it("ends an unpaid rental at once when it is cancelled", async () => {
    const p = await listed(6);
    const cy = await renter("renter.cy", 6);
    const r = await rent(rt, { renterUserId: cy.id, agentId: p.agent.id });
    const id = await setUp(r, cy);
    rt.clock.move(WEEK_MS);
    await renewDue(rt);
    await rentalControl(rt, await fresh(r), "cancel");
    expect((await fresh(r)).status).toBe("ended");
    expect((await installation(id)).status).toBe("stopped");
  });
});

describe("a fee per job", () => {
  const jobOf = async (id: string) => (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, id)))[0]!;
  const holdOf = async (jobId: string) => (await db.select().from(schema.holds).where(eq(schema.holds.jobId, jobId)))[0];

  it("is held before the job, captured when it finishes and released when it fails; a test run is free", async () => {
    const p = await listed(1, 0.5);
    const dee = await renter("renter.dee", 3);
    const r = await rent(rt, { renterUserId: dee.id, agentId: p.agent.id });
    const id = await setUp(r, dee);
    const inst = await installation(id);

    const test = await enqueue(rt, inst, { kind: "test" });
    expect(await holdJobFee(rt, test)).toEqual({ how: "none" });
    await db.update(schema.agentJobs).set({ status: "cancelled" }).where(eq(schema.agentJobs.id, test.id));

    const makerBefore = (await available(maker)).available;
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    expect((await jobOf(job.id)).status).toBe("done");
    expect(await holdOf(job.id)).toMatchObject({ kind: "job_fee", status: "held", amount: usdc(0.5).toString() });
    expect(await available(dee)).toEqual({ available: usdc(1.5), held: usdc(0.5) });
    expect(await settleJobFees(rt)).toBe(1);
    expect((await holdOf(job.id))!.status).toBe("captured");
    expect(await available(dee)).toEqual({ available: usdc(1.5), held: 0n });
    expect((await available(maker)).available - makerBefore).toBe(usdc(0.45));

    const failing = await enqueue(rt, inst, { kind: "manual" });
    expect((await holdJobFee(rt, failing)).how).toBe("held");
    // Held once, however often the job starts.
    expect(await holdJobFee(rt, await jobOf(failing.id))).toEqual({ how: "none" });
    await db.update(schema.agentJobs).set({ status: "failed" }).where(eq(schema.agentJobs.id, failing.id));
    await settleJobFees(rt);
    expect((await holdOf(failing.id))!.status).toBe("released");
    expect(await available(dee)).toEqual({ available: usdc(1.5), held: 0n });
  });

  it("fails the job, before it does anything, when the balance doesn't cover the fee", async () => {
    const p = await listed(1, 2);
    const eve = await renter("renter.eve", 2);
    const r = await rent(rt, { renterUserId: eve.id, agentId: p.agent.id });
    const id = await setUp(r, eve);
    const job = await enqueue(rt, await installation(id), { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    expect(await jobOf(job.id)).toMatchObject({ status: "failed", reason: FEE_SHORT(usdc(2).toString()) });
    expect(FEE_SHORT(usdc(2).toString())).toBe("Its fee per job (2.00 USDC) couldn't be set aside: your balance is too low. Top up your wallet, and it runs the next time.");
    expect(await db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, job.id))).toEqual([]);
    expect(await available(eve)).toEqual({ available: usdc(1), held: 0n });
  });
});

describe("the renter's dashboard", () => {
  it("adds up what it cost so far and this week, shows fees set aside, and when it runs next", async () => {
    const p = await listed(4, 0.5);
    const fay = await renter("renter.fay", 20);
    const r = await rent(rt, { renterUserId: fay.id, agentId: p.agent.id });
    let d = await rentalDetail(rt, r);
    expect(d).toMatchObject({ status: "setup", installation: null, nextRunAt: null, waiting: 0, money: { spentSoFar: usdc(4).toString(), thisWeek: usdc(4).toString(), feesHeld: "0" } });
    const id = await setUp(r, fay);
    const inst = await installation(id);
    // One job finished (its fee taken), one running (its fee set aside).
    const done = await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    await settleJobFees(rt);
    expect((await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, done.id)))[0]!.status).toBe("done");
    const running = await enqueue(rt, inst, { kind: "manual" });
    await holdJobFee(rt, running);
    d = await rentalDetail(rt, await fresh(r));
    expect(d.money).toEqual({ spentSoFar: usdc(4.5).toString(), thisWeek: usdc(4.5).toString(), feesHeld: usdc(0.5).toString() });
    expect(d.status).toBe("active");
    expect(d.installation).toMatchObject({ id, status: "active" });
    expect(d.installation!.recentJobs.map((j) => j.id)).toContain(done.id);
    // Restock runs on a schedule: its next run shows.
    expect(d.nextRunAt).not.toBeNull();
    // A new week: last week's fee is in what it cost so far, not this week.
    await db.update(schema.agentJobs).set({ status: "cancelled" }).where(eq(schema.agentJobs.id, running.id));
    await settleJobFees(rt);
    rt.clock.move(WEEK_MS);
    await renewDue(rt);
    d = await rentalDetail(rt, await fresh(r));
    expect(d.money).toEqual({ spentSoFar: usdc(8.5).toString(), thisWeek: usdc(4).toString(), feesHeld: "0" });
    // The list has it, with ended ones last.
    const list = await rentalsOf(rt, fay.id);
    expect(list.map((x) => x.id)).toEqual([r.id]);
  });
});
