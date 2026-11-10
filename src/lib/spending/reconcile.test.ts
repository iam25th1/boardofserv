// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, readyToPay, restockDefinition, testRuntime, withPayments, type TestRuntime } from "@/test/runtimeFixtures";
import { enqueue } from "@/lib/agents/runtime/jobs";
import { JobTools } from "@/lib/agents/runtime/tools";
import { reconcile } from "./reconcile";
import { moderate, moderationQueue } from "@/lib/safety/moderation";
import { paymentsPaused, setPaymentsPaused } from "./treasury";

// Reconciliation: each agent payment matched with its transfer on Base and
// its ledger entries, each transfer from the treasury with a send made
// here. Anything else pauses agent payments site wide with an admin alert.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let pay: ReturnType<typeof withPayments>;
let renter: schema.User;

const paying = () => {
  const d = restockDefinition();
  return {
    ...d,
    actions: [...d.actions, { id: "pay", tool: "wallet.pay" as const, description: "Pay the supplier" }],
    steps: [...d.steps, { id: "pay", kind: "action" as const, title: "Pay the supplier", inputs: [], outputs: [], action: "pay", next: null }],
  } as ReturnType<typeof restockDefinition>;
};

beforeAll(async () => {
  ({ client, db } = await testDb());
  renter = await addUser(db, "reconcile.renter");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await client.exec("delete from agent_payments; delete from withdrawals; delete from payment_alerts; delete from payment_settings;");
  rt = testRuntime(db);
  pay = withPayments(rt);
  await setPaymentsPaused(db as never, null, null);
});

// One payment of `whole` USDC through the real path, and the chain moved on
// past its confirmations. The first reconcile starts at the head, so it is
// run once before.
async function paid(whole = 1) {
  await reconcile(rt);
  const inst = await installed(rt, renter, await publishedAgent(db, renter, { definition: paying() }));
  const [payee] = await readyToPay(rt, inst, { payees: ["Weftworks"], allowanceUsdc: 10 });
  const job = await enqueue(rt, inst, { kind: "manual" });
  await new JobTools(rt, inst, paying(), job).call(paying().steps.at(-1)!, "wallet.pay", { to: "Weftworks", amountUsdc: whole }, undefined, { inputs: {}, untrusted: [], callKey: "1" });
  pay.chain.mine(3);
  const [p] = await db.select().from(schema.agentPayments).where(eq(schema.agentPayments.installationId, inst.id));
  return { inst, payee: payee!, p: p! };
}
const alerts = () => db.select().from(schema.paymentAlerts).where(eq(schema.paymentAlerts.status, "open"));

describe("reconciliation", () => {
  it("matches a payment with its transfer and its ledger entries, and lets payments run", async () => {
    const { p } = await paid();
    expect(await reconcile(rt)).toEqual([]);
    expect((await db.select().from(schema.agentPayments).where(eq(schema.agentPayments.id, p.id)))[0]!.reconciledAt).not.toBeNull();
    expect(await alerts()).toEqual([]);
    expect(await paymentsPaused(db as never)).toBeNull();
  });

  it("freezes payments on a transfer of another amount, or to another address", async () => {
    const { p } = await paid(2);
    const log = pay.chain.logs.find((l) => l.txHash.toLowerCase() === p.txHash!.toLowerCase())!;
    log.value = 2_500_000n;
    log.to = "0x00000000000000000000000000000000000000ee";
    const found = await reconcile(rt);
    expect(found.map((f) => f.kind).sort()).toEqual(["wrong_address", "wrong_amount"]);
    expect((await alerts()).map((a) => a.kind).sort()).toEqual(["wrong_address", "wrong_amount"]);
    expect(await paymentsPaused(db as never)).toMatch(/don't match/);
    // Raised once, however often it looks.
    await reconcile(rt);
    expect(await alerts()).toHaveLength(2);
  });

  it("freezes payments on a confirmed payment with no transfer on chain", async () => {
    const { p } = await paid();
    pay.chain.receipts.delete(p.txHash!);
    const found = await reconcile(rt);
    expect(found.map((f) => f.kind)).toContain("missing_transfer");
    expect(await paymentsPaused(db as never)).not.toBeNull();
  });

  it("freezes payments on a payment whose ledger charge is missing", async () => {
    const { p } = await paid();
    await db.delete(schema.ledgerEntries).where(eq(schema.ledgerEntries.idempotencyKey, `agentpay:${p.id}`));
    expect((await reconcile(rt)).map((f) => f.kind)).toEqual(["ledger"]);
  });

  it("freezes payments on a transfer from the treasury nobody here made, and a known withdrawal is fine", async () => {
    await reconcile(rt);
    pay.chain.transfer(pay.token, pay.treasury, "0x00000000000000000000000000000000000000ff", 3_000_000n, pay.chain.head + 1n);
    const w = pay.chain.transfer(pay.token, pay.treasury, "0x00000000000000000000000000000000000000bb", 5_000_000n, pay.chain.head + 1n);
    await db.insert(schema.withdrawals).values({ userId: renter.id, currency: "USDC", amount: "5000000", toAddress: "0x00000000000000000000000000000000000000bb", chainId: 84532, status: "paid", auto: false, idempotencyKey: "w-known", txHash: w.txHash, rawTx: "0x00", nonce: 9, fromAddress: pay.treasury.toLowerCase(), broadcastAt: new Date() });
    pay.chain.mine(4);
    const found = await reconcile(rt);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "unknown_transfer", details: { value: "3000000" } });
    expect(found[0]!.message).toBe("3.00 USDC left the treasury to 0x0000...00ff in a transfer no payment or withdrawal here made.");
  });

  it("waits in the admin queue until an admin looks, and payments stay paused until switched back on", async () => {
    await reconcile(rt);
    pay.chain.transfer(pay.token, pay.treasury, "0x00000000000000000000000000000000000000fe", 2_000_000n, pay.chain.head + 1n);
    pay.chain.mine(4);
    await reconcile(rt);
    const q = await moderationQueue(rt);
    expect(q.payments).toEqual([expect.objectContaining({ kind: "unknown_transfer", message: expect.stringContaining("2.00 USDC left the treasury") })]);
    const admin = await addUser(db, "reconcile.admin");
    expect(await moderate(rt, admin, { type: "payment", id: q.payments[0]!.id }, "hide", "x")).toBe(false);
    expect(await moderate(rt, admin, { type: "payment", id: q.payments[0]!.id }, "approve", "A test transfer by the owner.")).toBe(true);
    expect((await moderationQueue(rt)).payments).toEqual([]);
    expect(await paymentsPaused(db as never)).not.toBeNull();
    expect(await moderate(rt, admin, { type: "payment", id: q.payments[0]!.id }, "approve", "Again.")).toBe(false);
  });

  it("starts at the head the first time, so what the treasury sent before isn't counted", async () => {
    pay.chain.transfer(pay.token, pay.treasury, "0x00000000000000000000000000000000000000aa", 1_000_000n, pay.chain.head);
    pay.chain.mine(5);
    expect(await reconcile(rt)).toEqual([]);
    expect(await reconcile(rt)).toEqual([]);
  });
});
