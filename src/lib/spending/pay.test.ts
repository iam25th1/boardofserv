// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { keccak256, type Hex } from "viem";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, testRuntime, withPayments, type TestRuntime } from "@/test/runtimeFixtures";
import { balancesOf, ledgerTotal, post } from "@/lib/payments/ledger";
import { readPaymentsConfig } from "@/lib/payments/config";
import { enqueue } from "@/lib/agents/runtime/jobs";
import { JobTools } from "@/lib/agents/runtime/tools";
import { Paused } from "@/lib/agents/runner";
import { ToolError } from "@/lib/agents/toolbox";
import { InfraError } from "@/lib/agents/runner";
import { freeze } from "@/lib/safety/freeze";
import { allowanceOf, topUp } from "./allowance";
import { savePayee } from "./payees";
import { payFromAllowance, PaymentPending, PaymentRefused, settlePayments } from "./pay";
import { receiptsOf } from "./receipts";
import { paymentsNetworkProblem, paymentsPaused, setPaymentsPaused } from "./treasury";

// Agents' payments on chain: only to saved payees, from the allowance; the
// first to a payee asks; held, signed and recorded, sent, confirmed, then
// spent. One action never sends twice (after a crash too); one send leaves
// the treasury at a time, so nonces never collide; a reverted or stuck send
// releases the hold; a low treasury pauses payments site wide; Base Sepolia
// only.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let pay: ReturnType<typeof withPayments>;
let renter: schema.User;
let n = 0;

const SUPPLIER = "0x0000000000000000000000000000000000000000";
const usdc = (whole: number) => BigInt(Math.round(whole * 1e6));
const exec = () => db as never;

// The restock agent with a payment action: "Pay the supplier".
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
  renter = await addUser(db, "pay.renter");
});
afterAll(async () => client.close());
beforeEach(async () => {
  rt = testRuntime(db);
  pay = withPayments(rt);
  await setPaymentsPaused(exec(), null, null);
  // Each test has a new chain, its treasury's nonce at 0: the sends before it are another chain's.
  await client.exec("delete from agent_payments; delete from withdrawals; delete from payment_alerts;");
});

// An installation of the paying agent with an allowance and a saved payee
// it has paid before (so payments within the renter's limits don't ask).
async function ready(o: { allowance?: number; paidBefore?: boolean } = {}) {
  await post(exec(), { userId: renter.id, currency: "USDC", kind: "deposit", amount: usdc(50), key: `fund:${++n}` });
  const inst = await installed(rt, renter, await publishedAgent(db, renter, { definition: paying() }));
  await topUp(rt, renter, inst.id, usdc(o.allowance ?? 10), `top-${++n}-key`);
  const payee = await savePayee(rt, renter, inst.id, { label: "Weftworks", address: SUPPLIER });
  if (o.paidBefore ?? true) await db.update(schema.payees).set({ firstPaidAt: rt.now() }).where(eq(schema.payees.id, payee.id));
  const job = await enqueue(rt, inst, { kind: "manual" });
  return { inst, payee: { ...payee, firstPaidAt: o.paidBefore ?? true ? rt.now() : null }, job };
}

const tools = (inst: schema.AgentInstallation, job: schema.AgentJob) => new JobTools(rt, inst, paying(), job);
const callPay = (t: JobTools, args: unknown, o: { approval?: { answer: string | null }; key?: string } = {}) =>
  t.call(payStep(), "wallet.pay", args, o.approval, { inputs: {}, untrusted: [], callKey: o.key ?? `k${++n}` });
const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const paymentsOf = (installationId: string) => db.select().from(schema.agentPayments).where(eq(schema.agentPayments.installationId, installationId));

describe("an agent's payment", () => {
  it("goes to a saved payee from the allowance, on chain, and is spent once confirmed", async () => {
    const { inst, job } = await ready();
    const total = await ledgerTotal(renter.id, "USDC", exec());
    const out = (await callPay(tools(inst, job), { to: "weftworks", amountUsdc: 1.25, memo: "Linen order" })) as { paid: boolean; txId: Hex; amountUsdc: string };
    expect(out).toMatchObject({ paid: true, amountUsdc: "1.25", to: "Weftworks" });
    const [p] = await paymentsOf(inst.id);
    expect(p).toMatchObject({ status: "confirmed", amount: "1250000", toAddress: SUPPLIER, payeeLabel: "Weftworks", approvedBy: "rules", guard: "allow", memo: "Linen order", chainId: 84532 });
    expect(p!.txHash).toBe(out.txId);
    expect(await pay.chain.tokenBalance(pay.token, SUPPLIER)).toBe(usdc(1.25));
    expect(await allowanceOf(exec(), inst.id)).toEqual({ available: usdc(8.75), held: 0n });
    expect(await ledgerTotal(renter.id, "USDC", exec())).toBe(total - usdc(1.25));
  });

  it("pays only saved payees: anything else becomes a suggestion and nothing is paid", async () => {
    const { inst, job } = await ready();
    const out = await err(callPay(tools(inst, job), { to: "0x00000000000000000000000000000000000000aa", amountUsdc: 1 }));
    expect(out).toBeInstanceOf(ToolError);
    expect((out as Error).message).toMatch(/isn't one of this renter's saved payees, so nothing was paid/);
    expect((await db.select().from(schema.payees).where(eq(schema.payees.installationId, inst.id))).map((p) => p.status).sort()).toEqual(["active", "suggested"]);
    expect(await paymentsOf(inst.id)).toEqual([]);
    expect(pay.chain.sent).toEqual([]);
  });

  it("asks before the first payment to a payee, saying it can't be pulled back, then pays on a yes", async () => {
    const { inst, job } = await ready({ paidBefore: false });
    const asked = (await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 1 }, { key: "first" }))) as Paused;
    expect(asked).toBeInstanceOf(Paused);
    expect(asked.ask.question).toBe("Pay 1.00 USDC to Weftworks (0x0000...0000) from its allowance? Payments on Base can't be pulled back once they're sent.");
    expect(asked.ask.reason).toContain("It's the first payment to Weftworks: the first one to a payee always asks.");
    expect(asked.ask.opinion).toMatchObject({ risk: "money" });
    expect(pay.chain.sent).toEqual([]);
    await callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 1 }, { key: "first", approval: { answer: "Yes" } });
    const [p] = await paymentsOf(inst.id);
    expect(p).toMatchObject({ status: "confirmed", approvedBy: "renter" });
    expect((await db.select().from(schema.payees).where(eq(schema.payees.installationId, inst.id)))[0]!.firstPaidAt).not.toBeNull();
    // A no pays nothing.
    const no = await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 1 }, { key: "second", approval: { answer: "No" } }));
    expect(no).not.toBeNull();
    expect(await paymentsOf(inst.id)).toHaveLength(1);
  });

  it("can't spend more than its own allowance, and holds nothing when it can't", async () => {
    const { inst, job } = await ready({ allowance: 2 });
    const out = await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 3 }));
    expect((out as Error).message).toMatch(/Its allowance has 2.00 USDC, not the 3.00 USDC this payment needs, so nothing was paid/);
    expect(await allowanceOf(exec(), inst.id)).toEqual({ available: usdc(2), held: 0n });
    expect(await paymentsOf(inst.id)).toEqual([]);
    for (const bad of [0.0000001, -1, 0, 1e-9]) expect(await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: bad })), String(bad)).toBeInstanceOf(ToolError);
  });

  it("pays from its own installation's allowance only: another one's, even the same renter's, is never touched", async () => {
    const a = await ready({ allowance: 1 });
    const b = await ready({ allowance: 10 });
    const out = await err(callPay(tools(a.inst, a.job), { to: "Weftworks", amountUsdc: 5 }));
    expect((out as Error).message).toMatch(/Its allowance has 1.00 USDC, not the 5.00 USDC/);
    expect(await allowanceOf(exec(), b.inst.id)).toEqual({ available: usdc(10), held: 0n });
    // A payee saved on one installation isn't one the other may pay.
    await db.update(schema.payees).set({ status: "removed" }).where(eq(schema.payees.installationId, b.inst.id));
    const theirs = await err(callPay(tools(b.inst, b.job), { to: "Weftworks", amountUsdc: 1 }));
    expect((theirs as Error).message).toMatch(/isn't one of this renter's saved payees/);
    await callPay(tools(a.inst, a.job), { to: "Weftworks", amountUsdc: 1 });
    expect(await allowanceOf(exec(), a.inst.id)).toEqual({ available: 0n, held: 0n });
    expect(await allowanceOf(exec(), b.inst.id)).toEqual({ available: usdc(10), held: 0n });
  });

  it("pays nothing while agent payments are paused site wide, and says why", async () => {
    const { inst, job } = await ready();
    await setPaymentsPaused(exec(), "Checking the treasury.", null);
    const out = await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 1 }));
    expect((out as Error).message).toBe("Agent payments are paused on boardofserv for now: Checking the treasury. Nothing was paid.");
    expect(await allowanceOf(exec(), inst.id)).toEqual({ available: usdc(10), held: 0n });
    expect(pay.chain.sent).toEqual([]);
  });

  it("never sends twice for one action, after a crash or a restart", async () => {
    const { inst, job } = await ready();
    pay = withPayments(rt, { autoMine: false });
    rt.payments!.confirmWithinMs = 0;
    // Recorded and sent, then the server stops before it confirms.
    expect(await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 1 }, { key: "crash" }))).toBeInstanceOf(InfraError);
    const [p] = await paymentsOf(inst.id);
    expect(p!.status).toBe("broadcast");
    // The bytes were lost on the way, and the server restarts.
    pay.chain.mempool = [];
    rt.clock.move(60_000);
    const rt2 = testRuntime(db);
    rt2.clock.at = rt.clock.at;
    rt2.payments = { ...rt.payments!, wait: async (ms) => (rt2.clock.move(ms), pay.chain.mine()), confirmWithinMs: 5_000 };
    await new JobTools(rt2, inst, paying(), job).call(payStep(), "wallet.pay", { to: "Weftworks", amountUsdc: 1 }, undefined, { inputs: {}, untrusted: [], callKey: "crash" });
    const hashes = new Set(pay.chain.sent.map((raw) => keccak256(raw)));
    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toBe(p!.txHash);
    expect(await paymentsOf(inst.id)).toHaveLength(1);
    expect((await paymentsOf(inst.id))[0]!.status).toBe("confirmed");
    expect(await pay.chain.tokenBalance(pay.token, SUPPLIER)).toBe(usdc(1));
  });

  it("goes out one at a time from the treasury, so concurrent payments and withdrawals never share a nonce", async () => {
    const a = await ready();
    const b = await ready();
    const both = await Promise.all([callPay(tools(a.inst, a.job), { to: "Weftworks", amountUsdc: 1 }), callPay(tools(b.inst, b.job), { to: "Weftworks", amountUsdc: 2 })]);
    expect(both.map((x) => (x as { paid: boolean }).paid)).toEqual([true, true]);
    const nonces = [...(await paymentsOf(a.inst.id)), ...(await paymentsOf(b.inst.id))].map((p) => p.nonce);
    expect(new Set(nonces).size).toBe(2);
    // While a withdrawal is in flight from the treasury, a payment waits its turn, then goes.
    const c = await ready();
    const [w] = await db
      .insert(schema.withdrawals)
      .values({ userId: renter.id, currency: "USDC", amount: "5000000", toAddress: "0x00000000000000000000000000000000000000bb", chainId: 84532, status: "broadcast", auto: false, idempotencyKey: `w${++n}`, nonce: 2, fromAddress: pay.treasury.toLowerCase(), txHash: `0x${"ab".repeat(32)}`, rawTx: "0x00", broadcastAt: new Date() })
      .returning();
    rt.payments!.confirmWithinMs = 0;
    expect(await err(callPay(tools(c.inst, c.job), { to: "Weftworks", amountUsdc: 1 }, { key: "turn" }))).toBeInstanceOf(InfraError);
    expect((await paymentsOf(c.inst.id))[0]!.status).toBe("held");
    await db.update(schema.withdrawals).set({ status: "paid" }).where(eq(schema.withdrawals.id, w!.id));
    pay.chain.useNonce(pay.treasury);
    rt.payments!.confirmWithinMs = 5_000;
    await callPay(tools(c.inst, c.job), { to: "Weftworks", amountUsdc: 1 }, { key: "turn" });
    // Its nonce is past the withdrawal's.
    expect((await paymentsOf(c.inst.id))[0]).toMatchObject({ status: "confirmed", nonce: 3 });
  });

  it("releases the hold when the transfer reverts or gets stuck, and spends nothing", async () => {
    const { inst, job } = await ready();
    pay.chain.revertNext = true;
    const reverted = await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 1 }));
    expect((reverted as Error).message).toMatch(/reverted on Base\. Nothing was spent from its allowance/);
    expect(await allowanceOf(exec(), inst.id)).toEqual({ available: usdc(10), held: 0n });
    // Stuck: never mined, and its nonce taken by another transaction.
    rt.payments = { ...rt.payments!, wait: async (ms) => rt.clock.move(ms), confirmWithinMs: 0 };
    const s = await ready();
    await err(callPay(tools(s.inst, s.job), { to: "Weftworks", amountUsdc: 1 }, { key: "stuck" }));
    expect((await paymentsOf(s.inst.id))[0]!.status).toBe("broadcast");
    pay.chain.useNonce(pay.treasury);
    const stuck = await err(callPay(tools(s.inst, s.job), { to: "Weftworks", amountUsdc: 1 }, { key: "stuck" }));
    expect((stuck as Error).message).toMatch(/never mined/);
    expect(await allowanceOf(exec(), s.inst.id)).toEqual({ available: usdc(10), held: 0n });
  });

  it("pauses agent payments site wide, with an admin alert, when the treasury runs low", async () => {
    pay = withPayments(rt, { treasuryUsdc: usdc(5.5) });
    const { inst, job } = await ready();
    const low = await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 1 }));
    expect((low as Error).message).toMatch(/paused on boardofserv for now: The treasury's USDC is too low/);
    expect(await paymentsPaused(exec())).toMatch(/too low/);
    const [alert] = await db.select().from(schema.paymentAlerts).where(eq(schema.paymentAlerts.kind, "low_treasury"));
    expect(alert).toMatchObject({ status: "open" });
    expect(await allowanceOf(exec(), inst.id)).toEqual({ available: usdc(10), held: 0n });
    const next = await ready();
    expect((await err(callPay(tools(next.inst, next.job), { to: "Weftworks", amountUsdc: 1 })) as Error).message).toMatch(/paused/);
    expect(pay.chain.sent).toEqual([]);
  });

  it("can't pay while its agent or renter is frozen", async () => {
    const { inst, job } = await ready();
    const admin = await addUser(db, `pay.admin.${++n}`);
    await freeze(rt, admin, "agent", inst.agentId, "Checking its payments.");
    const out = await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 1 }));
    expect((out as Error).message).toMatch(/paused this: Checking its payments\. It can't pay anything now\./);
    expect(pay.chain.sent).toEqual([]);
  });

  it("is settled by the worker when its job stopped waiting, and released when its job ended unsent", async () => {
    const { inst, job } = await ready();
    pay = withPayments(rt, { autoMine: false });
    rt.payments!.confirmWithinMs = 0;
    await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 1 }));
    pay.chain.mine(3);
    expect(await settlePayments(rt)).toBeGreaterThan(0);
    expect((await paymentsOf(inst.id))[0]!.status).toBe("confirmed");
    // Held, never sent (the treasury was busy), and its job is over.
    const late = await ready();
    const [row] = await db
      .insert(schema.agentPayments)
      .values({ key: `job:${late.job.id}:orphan`, installationId: late.inst.id, agentId: late.inst.agentId, versionId: late.inst.versionId, jobId: late.job.id, ownerUserId: renter.id, payeeId: late.payee.id, payeeLabel: "Weftworks", toAddress: SUPPLIER, amount: "1000000", chainId: 84532, createdAt: rt.now(), updatedAt: rt.now() })
      .returning();
    await db.update(schema.allowances).set({ available: "9000000", held: "1000000" }).where(eq(schema.allowances.installationId, late.inst.id));
    await db.update(schema.agentJobs).set({ status: "failed" }).where(eq(schema.agentJobs.id, late.job.id));
    rt.clock.move(11 * 60_000);
    await db.update(schema.agentPayments).set({ updatedAt: new Date(rt.now().getTime() - 11 * 60_000) }).where(eq(schema.agentPayments.id, row!.id));
    await settlePayments(rt);
    expect((await paymentsOf(late.inst.id))[0]!.status).toBe("failed");
    expect(await allowanceOf(exec(), late.inst.id)).toEqual({ available: usdc(10), held: 0n });
  });
});

describe("a payment's receipt", () => {
  it("says what, to whom, by which agent and job, its transfer with an explorer link, the safety check and the approval", async () => {
    const { inst, job } = await ready({ paidBefore: false });
    rt.guardVerdict = () => ({ verdict: "ask", reason: "A first payment to this supplier." });
    const asked = (await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 2, memo: "Linen" }, { key: "r1" }))) as Paused;
    await db.insert(schema.agentApprovals).values({ jobId: job.id, installationId: inst.id, ownerUserId: renter.id, stepId: "pay", callIndex: 0, kind: "safety", question: asked.ask.question, reason: asked.ask.reason, options: [], noAnswer: "", status: "answered", answer: "Yes", answeredAt: rt.now(), expiresAt: rt.now() });
    await callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 2, memo: "Linen" }, { key: "r1", approval: { answer: "Yes" } });
    const [r] = await receiptsOf(rt, { installationId: inst.id });
    expect(r).toMatchObject({
      amount: "2000000",
      payee: { label: "Weftworks", address: SUPPLIER },
      agent: paying().name,
      jobId: job.id,
      memo: "Linen",
      status: "confirmed",
      network: "Base Sepolia",
      guard: { verdict: "ask", reason: "A first payment to this supplier." },
      approval: { by: "renter", question: asked.ask.question, answer: "Yes" },
    });
    expect(r!.explorer).toBe(`https://sepolia.basescan.org/tx/${r!.txHash}`);
  });
});

describe("Base Sepolia only", () => {
  it("refuses mainnet, another USDC or a mainnet RPC unless the explicit flag is set", async () => {
    const sepolia = readPaymentsConfig({ TREASURY_ADDRESS: SUPPLIER });
    expect(paymentsNetworkProblem(sepolia, {})).toBeNull();
    const mainnet = readPaymentsConfig({ TREASURY_ADDRESS: SUPPLIER, BOS_NETWORK: "base", BOS_MAINNET: "1" });
    expect(paymentsNetworkProblem(mainnet, {})).toBe("Agent payments run on Base Sepolia only.");
    expect(paymentsNetworkProblem(readPaymentsConfig({ TREASURY_ADDRESS: SUPPLIER, USDC_TOKEN_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }), {})).toMatch(/Base Sepolia's USDC/);
    expect(paymentsNetworkProblem(readPaymentsConfig({ TREASURY_ADDRESS: SUPPLIER, BOS_RPC_URL: "https://mainnet.base.org" }), {})).toMatch(/mainnet RPC/);
    expect(paymentsNetworkProblem(mainnet, { AGENT_PAYMENTS_MAINNET: "1" })).toBeNull();
    expect(paymentsNetworkProblem(readPaymentsConfig({}), {})).toBe("Payments are off on this server.");
    // And through a payment: nothing held, nothing sent.
    const { inst, job } = await ready();
    rt.payments = { ...rt.payments!, config: mainnet };
    const out = await err(callPay(tools(inst, job), { to: "Weftworks", amountUsdc: 1 }));
    expect((out as Error).message).toMatch(/Base Sepolia only/);
    expect(await paymentsOf(inst.id)).toEqual([]);
    void balancesOf;
    void PaymentPending;
    void PaymentRefused;
    void payFromAllowance;
  });
});
