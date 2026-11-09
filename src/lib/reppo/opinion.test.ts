// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { linkConnections, ownSheet, publishedAgent, restockDefinition, sheetRows, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { fakeReppo, type FakeReppo } from "@/test/fakeReppo";
import { install } from "@/lib/agents/runtime/installations";
import { answer, approvalsOf } from "@/lib/agents/runtime/approvals";
import { claimJob, enqueue, runJob } from "@/lib/agents/runtime/jobs";
import { deliverTelegram } from "@/lib/telegram/deliver";
import { reppoCycle } from "./cycle";

// Reppo's second opinion on a payment waiting for the renter's yes: asked
// beside the wait, from facts alone, shown when it comes and "still being
// checked" until then. The renter's answer is always the decision: a late
// opinion, a missing one, or one advising against never holds anything up
// or decides anything.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let reppo: FakeReppo;
let owner: schema.User;

// The restock agent, recording orders with their cost: a payment.
const paying = () => {
  const d = restockDefinition();
  return { ...d, actions: d.actions.map((a) => (a.tool === "sheets.write" ? { ...a, amountColumn: "cost_usdc" } : a)) } as ReturnType<typeof restockDefinition>;
};

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "opinion.owner", "opinion_owner");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(eq(schema.agentJobs.status, "queued"));
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
  reppo = fakeReppo(rt.net);
  reppo.readsToFinish = 1;
});
afterEach(() => vi.unstubAllEnvs());

// A job that waits for the renter's yes on an order worth more than twice
// their auto limit of 50 USDC.
async function waiting(definition = paying()) {
  await linkConnections(rt, owner);
  const sheet = ownSheet(rt);
  const p = await publishedAgent(db, owner, { definition });
  const inst = await install(rt, {
    ownerUserId: owner.id,
    agent: p.agent,
    version: p.version,
    policy: { autoSpendUsdc: 50 },
    answers: { settings: { stock_sheet: sheet.answer("Stock"), orders_sheet: sheet.answer("Orders"), suppliers_sheet: sheet.answer("Suppliers") }, rules: {}, timezone: "UTC", minGapMinutes: 0 },
  });
  const job = await enqueue(rt, inst, { kind: "manual" });
  await runJob(rt, (await claimJob(rt, "w"))!, "w");
  const [a] = await approvalsOf(rt, owner.id, { jobId: job.id });
  return { inst, job, a: a! };
}

const jobOf = async (id: string) => (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, id)))[0]!;
const evalOf = async (approvalId: string) => (await db.select().from(schema.reppoEvals).where(eq(schema.reppoEvals.approvalId, approvalId)))[0];
const messagesOf = async (installationId: string) => (await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, installationId))).map((m) => m.text);
async function resume() {
  await runJob(rt, (await claimJob(rt, "w"))!, "w");
}

describe("Reppo's second opinion", () => {
  it("is asked for beside a payment's wait, from facts alone", async () => {
    const { a } = await waiting();
    expect(a).toMatchObject({ kind: "safety", status: "pending", opinion: { state: "checking", score: null } });
    const row = (await evalOf(a.id))!;
    expect(row).toMatchObject({ kind: "action", taskType: "action", status: "queued" });
    expect(row.input).toContain("The action: Add the order to the orders sheet (it spends money)");
    expect(row.input).toContain("Why it waits for the person: it spends more than the person lets it spend without asking");
    expect(row.input).toContain("The amount: more than twice the person's auto limit");
    expect(row.input).toContain("Some of what it acts on came from outside the person's own answers");
    // Not the amount, the suppliers, the sheet or anything else of theirs.
    for (const bad of ["147", "USDC", "Weftworks", "Northmill", "Orders\"", "Linen", owner.id, "docs.google"]) expect(row.input, bad).not.toContain(bad);
  });

  it("says in Telegram that it is coming, shows when it arrives, and the yes still decides", async () => {
    const { inst, job, a } = await waiting();
    await deliverTelegram(rt);
    const asked = rt.net.telegram("sendMessage").map((m) => String(m.text)).find((t) => t.includes("asks:"))!;
    expect(asked).toContain("Reppo is still checking it for a second opinion, which will follow here. Your answer decides either way.");
    await reppoCycle(rt);
    rt.clock.move(31_000);
    await reppoCycle(rt);
    const [shown] = await approvalsOf(rt, owner.id, { jobId: job.id });
    expect(shown!.opinion).toMatchObject({ state: "ready", score: 82, route: "ship" });
    const told = (await messagesOf(inst.id)).find((t) => t.startsWith("Second opinion from Reppo"))!;
    expect(told).toMatch(/^Second opinion from Reppo on the question waiting at "Record the order": 82 out of 100, looks fine to it\. .+ Your answer decides: Reppo doesn't approve or block anything\.$/);
    // It goes to Telegram like any message.
    await deliverTelegram(rt);
    expect(rt.net.telegram("sendMessage").some((m) => String(m.text).includes("Second opinion from Reppo"))).toBe(true);
    // A good opinion approves nothing: the job still waits for the renter.
    expect((await jobOf(job.id)).status).toBe("waiting_for_owner");
    await answer(rt, owner.id, a.id, "No");
    await resume();
    expect((await jobOf(job.id)).status).toBe("cancelled");
    expect(sheetRows(rt, inst, "orders_sheet")).toEqual([]);
  });

  it("advising against it blocks nothing: the renter's yes runs it", async () => {
    reppo.verdict = () => ({ score: 21, route: "block", reason: "The order is far larger than this shop's usual ones." });
    const { inst, job, a } = await waiting();
    await reppoCycle(rt);
    rt.clock.move(31_000);
    await reppoCycle(rt);
    expect((await approvalsOf(rt, owner.id, { jobId: job.id }))[0]!.opinion).toMatchObject({ state: "ready", route: "block" });
    expect((await jobOf(job.id)).status).toBe("waiting_for_owner");
    await answer(rt, owner.id, a.id, "Yes");
    await resume();
    expect((await jobOf(job.id)).status).toBe("done");
    expect(sheetRows(rt, inst, "orders_sheet").length).toBeGreaterThan(0);
  });

  it("never holds up an answer: given before it comes, the job goes on, and it is only kept", async () => {
    const { inst, job, a } = await waiting();
    await answer(rt, owner.id, a.id, "Yes");
    await resume();
    expect((await jobOf(job.id)).status).toBe("done");
    await reppoCycle(rt);
    rt.clock.move(31_000);
    await reppoCycle(rt);
    expect((await evalOf(a.id))!.status).toBe("completed");
    expect((await messagesOf(inst.id)).some((t) => t.startsWith("Second opinion"))).toBe(false);
  });

  it("missing (Reppo down) holds up nothing, and says so once Reppo gives up", async () => {
    reppo.down = true;
    const { job, a } = await waiting();
    for (let i = 0; i < 6; i++) {
      await reppoCycle(rt, { call: { sleep: async () => undefined } });
      rt.clock.move(2 * 60 * 60_000);
    }
    const [shown] = await approvalsOf(rt, owner.id, { jobId: job.id });
    expect(shown!.opinion).toMatchObject({ state: "none" });
    expect(shown!.status).toBe("pending");
    await answer(rt, owner.id, a.id, "Yes");
    await resume();
    expect((await jobOf(job.id)).status).toBe("done");
  });

  it("isn't asked for without Reppo, with second opinions off, past the day's budget, or for an ordinary question", async () => {
    rt.services.reppo = null;
    expect((await waiting()).a.opinion).toBeNull();
    rt = testRuntime(db);
    rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
    vi.stubEnv("REPPO_ACTION_OPINIONS", "0");
    expect((await waiting()).a.opinion).toBeNull();
    vi.stubEnv("REPPO_ACTION_OPINIONS", "");
    vi.stubEnv("REPPO_DAILY_CREDITS", "0");
    expect((await waiting()).a.opinion).toBeNull();
    vi.stubEnv("REPPO_DAILY_CREDITS", "");
    // A write within the renter's own data that the safety check asks about: no payment, no new contact.
    rt.guardVerdict = () => ({ verdict: "ask", reason: "Unusual order." });
    const plain = await waiting(restockDefinition());
    expect(plain.a.kind).toBe("safety");
    expect(plain.a.opinion).toBeNull();
  });
});
