// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, testRuntime, trusted, withPayments, type TestRuntime } from "@/test/runtimeFixtures";
import { post } from "@/lib/payments/ledger";
import { enqueue } from "@/lib/agents/runtime/jobs";
import { JobTools } from "@/lib/agents/runtime/tools";
import { Paused } from "@/lib/agents/runner";
import { ToolError } from "@/lib/agents/toolbox";
import { freeze } from "@/lib/safety/freeze";
import { refreshVersion } from "@/lib/trust/trust";
import { approvalText } from "@/lib/telegram/deliver";
import { topUp } from "./allowance";
import { savePayee } from "./payees";
import { setPaymentsPaused } from "./treasury";
import { judgePayment, limitWhy, paymentLimits, siteDailyCap, tellBandDrop, type PaymentLimits } from "./limits";

// What an agent may pay without asking: its trust band per payment and per
// day, the renter's auto limit (never above the band), the site's day of
// payments; the strictest wins, a frozen or held agent pays nothing (even
// after a yes), and a renter is told when a lower score cuts their limit.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let pay: ReturnType<typeof withPayments>;
let renter: schema.User;
let n = 0;

const SUPPLIER = "0x0000000000000000000000000000000000000000";
const usdc = (whole: number) => BigInt(Math.round(whole * 1e6));
const exec = () => db as never;

const paying = () => {
  const d = restockDefinition();
  return {
    ...d,
    actions: [...d.actions, { id: "pay", tool: "wallet.pay" as const, description: "Pay the supplier" }],
    steps: [...d.steps, { id: "pay", kind: "action" as const, title: "Pay the supplier", inputs: [], outputs: [], action: "pay", next: null }],
  } as ReturnType<typeof restockDefinition>;
};
const payStep = () => paying().steps.find((s) => s.id === "pay")!;

beforeAll(async () => {
  ({ client, db } = await testDb());
  renter = await addUser(db, "limits.renter");
});
afterAll(async () => client.close());
beforeEach(async () => {
  rt = testRuntime(db);
  pay = withPayments(rt, { treasuryUsdc: usdc(5000) });
  await setPaymentsPaused(exec(), null, null);
  await client.exec("delete from agent_payments; delete from withdrawals; delete from payment_alerts;");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// A paying installation with an allowance, a payee it has paid before, the
// renter's auto limit and (unless new) a trust score.
async function ready(o: { auto?: number; score?: number | null; allowance?: number } = {}) {
  await post(exec(), { userId: renter.id, currency: "USDC", kind: "deposit", amount: usdc(200), key: `fund:${++n}` });
  const inst = await installed(rt, renter, await publishedAgent(db, renter, { definition: paying() }));
  const policy = { autoSpendUsdc: o.auto ?? 1000 };
  await db.update(schema.agentInstallations).set({ policy }).where(eq(schema.agentInstallations.id, inst.id));
  await topUp(rt, renter, inst.id, usdc(o.allowance ?? 100), `top-${++n}-key`);
  const payee = await savePayee(rt, renter, inst.id, { label: "Weftworks", address: SUPPLIER });
  await db.update(schema.payees).set({ firstPaidAt: rt.now() }).where(eq(schema.payees.id, payee.id));
  if (o.score !== null) await trusted(rt, inst.versionId, o.score ?? 650);
  const job = await enqueue(rt, inst, { kind: "manual" });
  return { inst: { ...inst, policy }, job };
}

const callPay = (inst: schema.AgentInstallation, job: schema.AgentJob, amountUsdc: number, approval?: { answer: string | null }) =>
  new JobTools(rt, inst, paying(), job).call(payStep(), "wallet.pay", { to: "Weftworks", amountUsdc }, approval, { inputs: {}, untrusted: [], callKey: `k${++n}` });
const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const paidOf = (installationId: string) => db.select().from(schema.agentPayments).where(eq(schema.agentPayments.installationId, installationId));

describe("judging a payment", () => {
  const base: PaymentLimits = {
    trust: { score: 650, label: "good", isNew: false, factors: [], band: { label: "good", perPayment: 25, perDay: 100 }, computedAt: null },
    renterAuto: usdc(1000),
    bandPayment: usdc(25),
    perPayment: usdc(25),
    perDay: usdc(100),
    paidToday: 0n,
    siteCap: usdc(1000),
    sitePaidToday: 0n,
    stopped: null,
  };

  it("lets the band cap a higher auto limit, and the auto limit win when it's lower", () => {
    expect(judgePayment(base, usdc(25))).toEqual({ refuse: null, asks: [] });
    expect(judgePayment(base, usdc(25.000001)).asks).toEqual(["It's over the 25.00 USDC a payment that its trust score of 650 (good) allows without asking (your own auto limit is 1000.00 USDC)."]);
    const own = { ...base, renterAuto: usdc(2), perPayment: usdc(2) };
    expect(judgePayment(own, usdc(3)).asks).toEqual(["It's over your auto limit of 2.00 USDC."]);
    expect(limitWhy(own)).toBe("Your auto limit: 2.00 USDC a payment, and up to 100.00 USDC a day.");
    expect(limitWhy(base)).toBe("You allow 1000.00 USDC a payment, but with its trust score of 650 (good) it may pay at most 25.00 USDC a payment and 100.00 USDC a day without asking.");
  });

  it("asks once a day's payments would go over the band's day", () => {
    expect(judgePayment({ ...base, paidToday: usdc(90) }, usdc(10)).asks).toEqual([]);
    expect(judgePayment({ ...base, paidToday: usdc(90) }, usdc(11)).asks).toEqual(["With it, today's payments come to 101.00 USDC, over the 100.00 USDC a day that its trust score of 650 (good) allows without asking."]);
  });

  it("asks every time with no auto limit, or a low score, whatever the other says", () => {
    expect(judgePayment({ ...base, renterAuto: 0n, perPayment: 0n }, 1n).asks).toEqual(["It spends money, and you approve every payment it makes."]);
    const low = { ...base, trust: { ...base.trust, score: 340, label: "low" as const }, bandPayment: 0n, perPayment: 0n, perDay: 0n };
    expect(judgePayment(low, 1n).asks).toEqual(["With its trust score of 340 (low) it can't pay anything without asking."]);
    expect(limitWhy(low)).toMatch(/You allow 1000\.00 USDC a payment, but with its trust score of 340 \(low\) it can't pay anything without asking/);
  });

  it("refuses, not asks, when stopped or over the site's day", () => {
    expect(judgePayment({ ...base, stopped: "Its listing is on hold for review." }, 1n)).toEqual({ refuse: "Its listing is on hold for review. It can't pay anything now.", asks: [] });
    expect(judgePayment({ ...base, sitePaidToday: usdc(999.5) }, usdc(1)).refuse).toMatch(/agent payments for today are used up, so nothing was paid/);
  });

  it("reads the site's daily cap, falling back on anything that isn't an amount", () => {
    expect(siteDailyCap({})).toBe(usdc(1000));
    expect(siteDailyCap({ AGENT_PAYMENTS_SITE_DAILY_USDC: "50" })).toBe(usdc(50));
    expect(siteDailyCap({ AGENT_PAYMENTS_SITE_DAILY_USDC: "0" })).toBe(0n);
    for (const bad of ["-5", "1e9", "lots", "1.0000001", " "]) expect(siteDailyCap({ AGENT_PAYMENTS_SITE_DAILY_USDC: bad })).toBe(usdc(1000));
  });
});

describe("an agent's payment within its limits", () => {
  it("is capped by a new agent's band: within it goes, over it asks and says the band", async () => {
    const { inst, job } = await ready({ score: null });
    expect((await paymentLimits(rt, inst)).perPayment).toBe(usdc(5));
    await callPay(inst, job, 5);
    const asked = (await err(callPay(inst, job, 6))) as Paused;
    expect(asked).toBeInstanceOf(Paused);
    expect(asked.ask.reason).toBe(
      "It's over the 5.00 USDC a payment that its trust score of 600 (new) allows without asking (your own auto limit is 1000.00 USDC). With its trust score of 600 (new) it may pay up to 5.00 USDC a payment and 20.00 USDC a day without asking.",
    );
    // A yes pays it.
    await callPay(inst, job, 6, { answer: "Yes" });
    expect((await paidOf(inst.id)).map((p) => [p.amount, p.approvedBy])).toEqual([
      ["5000000", "rules"],
      ["6000000", "renter"],
    ]);
  });

  it("says why it asks, with the band, in its Telegram message too", () => {
    const reason = "It's over the 5.00 USDC a payment that its trust score of 600 (new) allows without asking (your own auto limit is 1000.00 USDC).";
    const text = approvalText({ question: "Pay 6.00 USDC to Weftworks (0x0000...0000) from its allowance?", options: [{ label: "Yes", effect: "It pays." }], noAnswer: "No answer by tomorrow stops the job.", stepId: "pay", reason }, paying());
    expect(text).toContain(`Why it asks: ${reason}`);
    expect(text.indexOf("Why it asks")).toBeGreaterThan(text.indexOf("Pay 6.00 USDC"));
  });

  it("asks when a day's payments would pass the band's day, counting payments held and confirmed", async () => {
    const { inst, job } = await ready({ score: 520 });
    for (let i = 0; i < 4; i++) await callPay(inst, job, 5);
    const asked = (await err(callPay(inst, job, 1))) as Paused;
    expect(asked.ask.reason).toMatch(/^With it, today's payments come to 21\.00 USDC, over the 20\.00 USDC a day that its trust score of 520 \(fair\)/);
    // Tomorrow (UTC) starts again.
    rt.clock.move(24 * 3_600_000);
    await callPay(inst, job, 5);
  });

  it("lets the strictest win: the renter's lower auto limit asks inside the band", async () => {
    const { inst, job } = await ready({ auto: 2, score: 800 });
    await callPay(inst, job, 2);
    const asked = (await err(callPay(inst, job, 2.5))) as Paused;
    expect(asked.ask.reason).toMatch(/^It's over your auto limit of 2\.00 USDC\. With its trust score of 800 \(excellent\) it may pay up to 250\.00 USDC/);
  });

  it("asks before every payment at a low score, even with an auto limit", async () => {
    const { inst, job } = await ready({ score: 330 });
    const asked = (await err(callPay(inst, job, 0.01))) as Paused;
    expect(asked.ask.reason).toMatch(/^With its trust score of 330 \(low\) it can't pay anything without asking\./);
    expect(pay.chain.sent).toEqual([]);
  });

  it("refuses once the site's day of agent payments is used up, and pays nothing", async () => {
    vi.stubEnv("AGENT_PAYMENTS_SITE_DAILY_USDC", "7");
    const a = await ready();
    const b = await ready();
    await callPay(a.inst, a.job, 5);
    const out = await err(callPay(b.inst, b.job, 3));
    expect(out).toBeInstanceOf(ToolError);
    expect((out as Error).message).toMatch(/agent payments for today are used up/);
    // Not even a yes gets past it.
    expect(await err(callPay(b.inst, b.job, 3, { answer: "Yes" }))).toBeInstanceOf(ToolError);
    expect(await paidOf(b.inst.id)).toEqual([]);
  });

  it("refuses a frozen agent, or one held for review, even after a yes", async () => {
    const f = await ready();
    const admin = await addUser(db, `limits.admin.${++n}`);
    await freeze(rt, admin, "version", f.inst.versionId, "Checking its payments.");
    const frozen = await err(callPay(f.inst, f.job, 1, { answer: "Yes" }));
    expect((frozen as Error).message).toBe("boardofserv paused this: Checking its payments. It can't pay anything now.");
    const h = await ready();
    await db.insert(schema.agentListings).values({ agentId: h.inst.agentId, versionId: h.inst.versionId, weeklyPrice: "0", jobFee: "0", listed: true, screen: "held" });
    const held = await err(callPay(h.inst, h.job, 1));
    expect((held as Error).message).toBe("Its listing is on hold for review. It can't pay anything now.");
    expect(pay.chain.sent).toEqual([]);
  });
});

describe("a falling score", () => {
  it("cuts the renter's effective limit with it, and tells renters whose limit it cuts, once", async () => {
    const { inst } = await ready({ auto: 50, score: 720 });
    // Jobs that fail: the score falls to low, where it can't pay without asking.
    const at = rt.now();
    for (let i = 0; i < 10; i++) {
      await db.insert(schema.agentJobs).values({ installationId: inst.id, versionId: inst.versionId, ownerUserId: renter.id, status: "failed", trigger: { kind: "schedule" }, finishedAt: at, createdAt: at, updatedAt: at, reppoSample: "skipped" });
    }
    await refreshVersion(rt, inst.versionId);
    const l = await paymentLimits(rt, inst);
    expect(l.trust.label).toBe("low");
    expect(l.perPayment).toBe(0n);
    const told = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id));
    expect(told.map((m) => m.text)).toEqual([`Fabric restock's trust score fell to ${l.trust.score} (${l.trust.label}), so it now asks you before every payment, whatever your auto limit.`]);
    // The same score again: nothing more to say.
    await refreshVersion(rt, inst.versionId);
    expect(await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id))).toHaveLength(1);
  });

  it("says the new limit when it falls a band, and says nothing when it rises", async () => {
    const { inst } = await ready({ auto: 100, score: 800 });
    const t = (score: number, label: "excellent" | "good", perPayment: number, perDay: number) => ({ score, label, isNew: false, factors: [], band: { label, perPayment, perDay }, computedAt: null });
    expect(await tellBandDrop(rt, inst.versionId, t(800, "excellent", 250, 1000), t(640, "good", 25, 100), "Fabric restock")).toBe(1);
    const [m] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id));
    expect(m!.text).toBe("Fabric restock's trust score fell to 640 (good), so it may now pay up to 25.00 USDC a payment and 100.00 USDC a day without asking, less than your auto limit of 100.00 USDC. Anything over that asks you first.");
    expect(await tellBandDrop(rt, inst.versionId, t(640, "good", 25, 100), t(800, "excellent", 250, 1000), "Fabric restock")).toBe(0);
  });

  it("doesn't tell a renter who approves every payment anyway", async () => {
    const { inst } = await ready({ auto: 0, score: 720 });
    const at = rt.now();
    for (let i = 0; i < 10; i++) {
      await db.insert(schema.agentJobs).values({ installationId: inst.id, versionId: inst.versionId, ownerUserId: renter.id, status: "failed", trigger: { kind: "schedule" }, finishedAt: at, createdAt: at, updatedAt: at, reppoSample: "skipped" });
    }
    await refreshVersion(rt, inst.versionId);
    expect(await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id))).toEqual([]);
  });
});
