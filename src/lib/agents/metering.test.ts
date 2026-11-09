// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, sheetRows, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { balancesOf, ledgerTotal, post } from "@/lib/payments/ledger";
import { chargeModelShares, MODEL_SHORT } from "@/lib/market/charges";
import { answer } from "./runtime/approvals";
import { claimJob, enqueue, runJob } from "./runtime/jobs";
import { resumeAllowances } from "./runtime/allowances";
import { GUARD_OVER_BUDGET, JobTools } from "./runtime/tools";
import { allowancePause, budgetDTO, budgetGate, callEstimate, costMicros, estimateWeekly, runsPerWeek, weekCost } from "./metering";
import { Paused } from "./runner";

// Model cost inside runs: every call metered per installation and job in
// tokens and USDC, a weekly budget that asks before going over, free agents
// paused when their allowance is used up (and started again on Monday),
// and renters charged their jobs' model cost when the maker passes it on.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "meter.maker");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(eq(schema.agentJobs.status, "queued"));
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
});
afterEach(() => vi.unstubAllEnvs());

const jobOf = async (id: string) => (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, id)))[0]!;
const instOf = async (id: string) => (await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, id)))[0]!;
async function runOnce(inst: schema.AgentInstallation) {
  const job = await enqueue(rt, inst, { kind: "manual" });
  await runJob(rt, (await claimJob(rt, "w"))!, "w");
  return jobOf(job.id);
}
// A renter of a paid rental, so the free allowance doesn't apply.
async function rented(budget?: string, modelShare = false) {
  const renter = await addUser(db, `meter.renter.${Math.random().toString(36).slice(2, 8)}`);
  const p = await publishedAgent(db, maker);
  const inst = await installed(rt, renter, p);
  await db.insert(schema.rentals).values({ agentId: p.agent.id, versionId: p.version.id, renterUserId: renter.id, makerUserId: maker.id, weeklyPrice: "1000000", jobFee: "0", modelShare, installationId: inst.id, paidUntil: new Date(rt.now().getTime() + 7 * 86_400_000) });
  if (budget !== undefined) await db.update(schema.agentInstallations).set({ modelBudget: budget }).where(eq(schema.agentInstallations.id, inst.id));
  return { renter, inst: await instOf(inst.id) };
}

describe("the meter", () => {
  it("prices a call at the configured rates, in USDC minor units", () => {
    expect(costMicros({ provider: "serv", promptTokens: 600, completionTokens: 25 })).toBe(913n);
    vi.stubEnv("SERV_PRICE_INPUT_PER_M", "2");
    expect(costMicros({ provider: "serv", promptTokens: 1_000_000, completionTokens: 0 })).toBe(2_000_000n);
  });

  it("records every model call of a job: its decision, the guard's check and the screens, by installation and job", async () => {
    const { inst } = await rented();
    const job = await runOnce(inst);
    expect(job.status).toBe("done");
    const rows = await db.select().from(schema.agentModelUsage).where(eq(schema.agentModelUsage.jobId, job.id));
    expect(rows.map((r) => r.purpose).sort()).toEqual(["decision", "guard", "screen", "screen"].sort());
    for (const r of rows) expect(r).toMatchObject({ installationId: inst.id, agentId: inst.agentId, ownKey: false, day: rt.now().toISOString().slice(0, 10) });
    const guard = rows.find((r) => r.purpose === "guard")!;
    expect(guard).toMatchObject({ promptTokens: 600, completionTokens: 25, cost: "913" });
    expect((await weekCost(rt, inst.id)).all).toBe(rows.reduce((t, r) => t + BigInt(r.cost), 0n));
  });
});

describe("the weekly budget", () => {
  it("asks before a decision would go over it; a yes lets the job finish without asking again", async () => {
    const { renter, inst } = await rented("1");
    const job = await runOnce(inst);
    expect(job.status).toBe("waiting_for_owner");
    const [a] = await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.jobId, job.id));
    expect(a).toMatchObject({ kind: "safety", reason: "It would go over the weekly model budget for this agent." });
    expect(a!.question).toMatch(/^This agent has used [\d.]+ USDC of its 0\.000001 USDC weekly model budget\. Let this job go over it\?$/);
    expect(rt.asked).toEqual([]);
    await answer(rt, renter.id, a!.id, "Yes");
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    // Over budget, the guard can't be asked either: the order waits.
    const [b] = await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.jobId, job.id)).then((rows) => rows.filter((r) => r.id !== a!.id));
    expect(b).toMatchObject({ kind: "safety", reason: GUARD_OVER_BUDGET });
    await answer(rt, renter.id, b!.id, "Yes");
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    expect((await jobOf(job.id)).status).toBe("done");
    expect(sheetRows(rt, inst, "orders_sheet").length).toBeGreaterThan(0);
  });

  it("stops the job at a no", async () => {
    const { renter, inst } = await rented("1");
    const job = await runOnce(inst);
    const [a] = await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.jobId, job.id));
    await answer(rt, renter.id, a!.id, "No");
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    expect(await jobOf(job.id)).toMatchObject({ status: "cancelled" });
    expect((await jobOf(job.id)).reason).toMatch(/^You said no to going over the weekly model budget/);
  });

  it("keeps a renter's budget within the platform's ceiling, and shows it", async () => {
    vi.stubEnv("AGENT_MODEL_BUDGET_CEILING_USDC", "2");
    const { inst } = await rented("900000000");
    expect(await budgetDTO(rt, inst)).toMatchObject({ budget: "2000000", ceiling: "2000000", makerDefault: "1000000", free: false });
  });
});

describe("free agents", () => {
  it("pause with a plain message once the week's allowance is used up, and start again on Monday", async () => {
    vi.stubEnv("AGENT_FREE_MODEL_ALLOWANCE_USDC", "0.000001");
    const owner = await addUser(db, "meter.free");
    const inst = await installed(rt, owner, await publishedAgent(db, maker));
    const job = await runOnce(inst);
    expect(job).toMatchObject({ status: "failed", reason: allowancePause(1n) });
    expect(await instOf(inst.id)).toMatchObject({ status: "paused", pausedReason: allowancePause(1n) });
    expect(allowancePause(1n)).toBe("Its free model allowance of 0.000001 USDC for this week is used up, so it is paused. It starts again on Monday, or sooner on your own SERV key.");
    // Still this week: it stays paused.
    expect(await resumeAllowances(rt)).toBe(0);
    vi.stubEnv("AGENT_FREE_MODEL_ALLOWANCE_USDC", "1");
    // Calls on a renter's own SERV key don't count toward the allowance.
    expect((await budgetGate(rt, inst, true)).kind).toBe("ok");
    expect(await resumeAllowances(rt)).toBe(1);
    expect((await instOf(inst.id)).status).toBe("active");
  });
});

describe("model cost passed on to renters", () => {
  it("charges each ended job's site-paid model cost to the platform, once", async () => {
    const { renter, inst } = await rented(undefined, true);
    await post(db as never, { userId: renter.id, currency: "USDC", kind: "deposit", amount: 5_000_000n, key: `fund:${renter.id}` });
    const job = await runOnce(inst);
    const cost = (await db.select().from(schema.agentModelUsage).where(eq(schema.agentModelUsage.jobId, job.id))).reduce((t, r) => t + BigInt(r.cost), 0n);
    expect(cost).toBeGreaterThan(0n);
    const platformBefore = await ledgerTotal(null, "USDC", db as never);
    expect(await chargeModelShares(rt)).toBe(1);
    expect(await chargeModelShares(rt)).toBe(0);
    expect((await balancesOf(renter.id, db as never)).USDC.available).toBe(5_000_000n - cost);
    expect((await ledgerTotal(null, "USDC", db as never)) - platformBefore).toBe(cost);
    expect((await jobOf(job.id)).modelSettledAt).not.toBeNull();
  });

  it("pauses the installation with a plain message when the balance can't cover it", async () => {
    const { inst } = await rented(undefined, true);
    const job = await runOnce(inst);
    const cost = (await db.select().from(schema.agentModelUsage).where(eq(schema.agentModelUsage.jobId, job.id))).reduce((t, r) => t + BigInt(r.cost), 0n);
    await chargeModelShares(rt);
    expect(await instOf(inst.id)).toMatchObject({ status: "paused", pausedReason: MODEL_SHORT(cost) });
  });
});

describe("the estimate on a listing", () => {
  it("counts runs a week from its triggers and its model calls a run", () => {
    const d = restockDefinition();
    expect(runsPerWeek(d)).toBe(7);
    expect(runsPerWeek({ triggers: [{ kind: "schedule", every: "hour", at: null, description: "" }] as never })).toBe(168);
    const decisions = d.steps.filter((s) => s.kind === "decision").length;
    const actions = d.steps.filter((s) => s.kind === "action").length;
    expect(estimateWeekly(d)).toBe(BigInt(7 * (decisions * 2 + actions)) * callEstimate());
  });
});

describe("the guard over budget", () => {
  it("asks instead of checking when the week's budget is used up", async () => {
    const { inst } = await rented("1");
    const d = restockDefinition();
    const paused = (await new JobTools(rt, inst, d, null).call(d.steps.find((s) => s.id === "record")!, "sheets.write", { sheet: "Orders", rows: [{ fabric: "Linen" }] }).catch((e: unknown) => e)) as Paused;
    expect(paused.ask).toMatchObject({ kind: "safety", reason: GUARD_OVER_BUDGET });
    expect(rt.guarded).toEqual([]);
  });
});
