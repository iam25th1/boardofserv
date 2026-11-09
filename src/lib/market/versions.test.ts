// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { linkConnections, ownSheet, publishedAgent, RESTOCK_CODE, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { restockBench } from "@/test/agentFixtures";
import { breakingChange, type AgentDefinition } from "@/lib/agents/definition";
import { claimJob, enqueue, runJob } from "@/lib/agents/runtime/jobs";
import { control, loadInstallation } from "@/lib/agents/runtime/installations";
import { post } from "@/lib/payments/ledger";
import { settleJobFees } from "./charges";
import { makerDashboard, weekStart } from "./dashboard";
import { installRental, rent, rentalDTOs, renewDue, WEEK_MS } from "./rentals";
import { answerOffer, offerText, offerVersion } from "./versions";

// A new version of a rented agent: offered to its renters, who update (in
// place, or by setting up again when it's a breaking change) or stay; and
// the maker's dashboard, which never shows a renter's data.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let funded = 0;
const usdc = (whole: number) => BigInt(Math.round(whole * 1e6));

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
  maker = await addUser(db, "versions.maker", "lena_k");
});
afterAll(async () => client.close());

async function renter(handle: string, balance = 50) {
  const u = await addUser(db, handle, handle.replace(".", "_"));
  await post(db as never, { userId: u.id, currency: "USDC", kind: "deposit", amount: usdc(balance), key: `fund:${u.id}:${++funded}` });
  return u;
}

async function listedAgent(weekly = 3, fee = 0) {
  const p = await publishedAgent(db, maker);
  await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: usdc(weekly).toString(), jobFee: usdc(fee).toString() });
  return p;
}

async function newVersion(p: { agent: schema.Agent }, number: number, definition: AgentDefinition = restockDefinition()) {
  const [v] = await db.insert(schema.agentVersions).values({ agentId: p.agent.id, number, state: "published", publishedAt: new Date(), definition, code: RESTOCK_CODE, bench: restockBench() }).returning();
  return v!;
}

async function rentAndSetUp(p: { agent: schema.Agent }, who: schema.User) {
  const r = await rent(rt, { renterUserId: who.id, agentId: p.agent.id });
  await linkConnections(rt, who);
  const sheet = ownSheet(rt);
  const id = await installRental(rt, r, { settings: { stock_sheet: sheet.answer("Stock"), orders_sheet: sheet.answer("Orders"), suppliers_sheet: sheet.answer("Suppliers") }, rules: {}, timezone: "UTC", minGapMinutes: 0 });
  await control(rt, (await loadInstallation(rt, id))!, "golive");
  return { r, id };
}
const fresh = async (id: string) => (await db.select().from(schema.rentals).where(eq(schema.rentals.id, id)))[0]!;
const inst = async (id: string) => (await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, id)))[0]!;

describe("a breaking change", () => {
  it("is a setup question added, removed or changed, or a new connection; a new step or rule is not", () => {
    const d = restockDefinition();
    expect(breakingChange(d, d)).toBeNull();
    expect(breakingChange(d, { ...d, rules: [...d.rules, { key: "extra", label: "Extra", type: "number", value: "1" } as never] })).toBeNull();
    expect(breakingChange(d, { ...d, settings: [...d.settings, { key: "notes", label: "Notes tab", type: "text", help: "" } as never] })).toBe('It asks something new at setup ("Notes tab").');
    expect(breakingChange(d, { ...d, settings: d.settings.slice(1) })).toMatch(/^It no longer asks /);
    expect(breakingChange(d, { ...d, settings: d.settings.map((s, i) => (i === 0 ? { ...s, type: "text" } : s)) as never })).toMatch(/takes a different kind of answer now\.$/);
  });
});

describe("a new version", () => {
  it("moves the board to it, and offers it to those renting the old one, in Rented and in Telegram", async () => {
    const p = await listedAgent();
    const amy = await renter("ver.amy");
    const { r, id } = await rentAndSetUp(p, amy);
    const notSetUp = await rent(rt, { renterUserId: (await renter("ver.bo")).id, agentId: p.agent.id });
    const v2 = await newVersion(p, 2);
    expect(await offerVersion(rt, p.agent.id, v2)).toBe(1);
    expect((await db.select().from(schema.agentListings).where(eq(schema.agentListings.agentId, p.agent.id)))[0]!.versionId).toBe(v2.id);
    // One not set up yet just moves with it.
    expect(await fresh(notSetUp.id)).toMatchObject({ versionId: v2.id, offeredVersionId: null });
    expect(await fresh(r.id)).toMatchObject({ versionId: p.version.id, offeredVersionId: v2.id });
    expect((await rentalDTOs(rt, [await fresh(r.id)]))[0]!.offer).toEqual({ version: 2, breaking: null });
    const [told] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, id));
    expect(told).toMatchObject({ from: "agent", tgState: "pending", text: offerText("Fabric restock", 2) });
    expect(told!.text).toBe("Version 2 of Fabric restock is out. Open Rented on boardofserv to update to it or stay on the version you have.");

    // Updating swaps it in place, answers kept.
    const before = await inst(id);
    expect(await answerOffer(rt, await fresh(r.id), "update")).toEqual({ setupAgain: false });
    expect(await inst(id)).toMatchObject({ versionId: v2.id, settings: before.settings, status: "active" });
    expect(await fresh(r.id)).toMatchObject({ versionId: v2.id, offeredVersionId: null });
    expect(await db.select().from(schema.agentTriggers).where(eq(schema.agentTriggers.installationId, id))).not.toEqual([]);
    await expect(answerOffer(rt, await fresh(r.id), "update")).rejects.toMatchObject({ status: 409 });
  });

  it("lets a renter stay, and asks for setting up again when it is a breaking change", async () => {
    const p = await listedAgent();
    const cy = await renter("ver.cy");
    const dee = await renter("ver.dee");
    const a = await rentAndSetUp(p, cy);
    const b = await rentAndSetUp(p, dee);
    const d = restockDefinition();
    const v2 = await newVersion(p, 2, { ...d, settings: [...d.settings, { key: "notes", label: "Notes tab", type: "text", help: "Anything", required: false } as never] });
    await offerVersion(rt, p.agent.id, v2);
    expect((await rentalDTOs(rt, [await fresh(a.r.id)]))[0]!.offer).toEqual({ version: 2, breaking: 'It asks something new at setup ("Notes tab").' });
    expect(await answerOffer(rt, await fresh(a.r.id), "stay")).toEqual({ setupAgain: false });
    expect(await fresh(a.r.id)).toMatchObject({ versionId: p.version.id, offeredVersionId: null });
    expect((await inst(a.id)).versionId).toBe(p.version.id);
    expect(await answerOffer(rt, await fresh(b.r.id), "update")).toEqual({ setupAgain: true });
    expect(await fresh(b.r.id)).toMatchObject({ versionId: v2.id, installationId: null });
    expect((await inst(b.id)).status).toBe("stopped");
    expect((await rentalDTOs(rt, [await fresh(b.r.id)]))[0]!.status).toBe("setup");
  });
});

describe("the maker's dashboard", () => {
  it("shows renters, earnings by week, how renters' jobs went and where they failed, and versions", async () => {
    const p = await listedAgent(10, 1);
    const eli = await renter("dash.eli");
    const fin = await renter("dash.fin");
    const a = await rentAndSetUp(p, eli);
    await rentAndSetUp(p, fin);
    // One job done (its fee taken), one failed at its first step.
    const ok = await enqueue(rt, await inst(a.id), { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    await db.update(schema.agentVersions).set({ code: { ...RESTOCK_CODE, find_low: { ...RESTOCK_CODE.find_low, source: "async function run() { throw new Error('the Stock tab of eli is empty'); }" } } }).where(eq(schema.agentVersions.id, p.version.id));
    const bad = await enqueue(rt, await inst(a.id), { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    await settleJobFees(rt);
    const jobs = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, a.id));
    expect(jobs.find((j) => j.id === ok.id)!.status).toBe("done");
    expect(jobs.find((j) => j.id === bad.id)!.status).toBe("failed");
    // A week later, both renew.
    rt.clock.move(WEEK_MS);
    await renewDue(rt);

    const dash = await makerDashboard(rt, p.agent);
    expect(dash.renters.map((x) => [x.handle, x.status, x.weeksPaid]).sort()).toEqual([
      ["dash_eli", "active", 2],
      ["dash_fin", "active", 2],
    ]);
    // 4 weeks at 10 and one fee of 1: the maker's 90%.
    expect(dash.earnedTotal).toBe(usdc(36.9).toString());
    expect(dash.earnings).toHaveLength(8);
    expect(dash.earnings.reduce((t, w) => t + BigInt(w.amount), 0n)).toBe(usdc(36.9));
    expect(dash.earnings.at(-1)!.week).toBe(weekStart(rt.now()).toISOString());
    expect(dash.jobs).toEqual({ done: 1, failed: 1 });
    expect(dash.failures).toEqual([{ step: restockDefinition().steps.find((s) => s.id === "find_low")!.title, count: 1 }]);
    expect(dash.versions).toEqual([{ number: 1, publishedAt: expect.any(String), renters: 2, offered: 0 }]);
    // Nothing of the renters' own.
    expect(JSON.stringify(dash)).not.toMatch(/the Stock tab of eli|Stock|docs\.google|@example/);
  });

  it("starts a week on Monday", () => {
    expect(weekStart(new Date("2026-11-12T10:00:00Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(weekStart(new Date("2026-11-09T00:00:00Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(weekStart(new Date("2026-11-15T23:59:00Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });
});
