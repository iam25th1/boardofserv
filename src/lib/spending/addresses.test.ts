// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, testRuntime, trusted, withPayments, type TestRuntime } from "@/test/runtimeFixtures";
import { post } from "@/lib/payments/ledger";
import { enqueue } from "@/lib/agents/runtime/jobs";
import { JobTools } from "@/lib/agents/runtime/tools";
import { Paused } from "@/lib/agents/runner";
import { guardRequest } from "@/lib/agents/guard";
import { topUp } from "./allowance";
import { savePayee } from "./payees";
import { setPaymentsPaused } from "./treasury";
import { spendingOf } from "./dto";
import { addressFacts, FLAG_WORDS } from "./addresses";

// A payment is judged by its address, never the name its renter saved it
// under: the maker's own wallet, the treasury, another maker's wallet or
// an address many other renters pay make it high risk, so it always asks
// with a plain warning; and renaming a payee never changes what the safety
// check is asked, or what it answers.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let renter: schema.User;
let n = 0;

const usdc = (whole: number) => BigInt(Math.round(whole * 1e6));
const exec = () => db as never;
const addr = (k: number) => getAddress(`0x${k.toString(16).padStart(40, "0")}`);
const link = (userId: string, address: string) => db.insert(schema.linkedWallets).values({ userId, address: address.toLowerCase() });

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
  maker = await addUser(db, "addr.maker", "addr_maker");
  renter = await addUser(db, "addr.renter", "addr_renter");
});
afterAll(async () => client.close());
beforeEach(async () => {
  rt = testRuntime(db);
  withPayments(rt, { treasuryUsdc: usdc(5000) });
  await setPaymentsPaused(exec(), null, null);
  await client.exec("delete from agent_payments;");
});

// The maker's agent, rented (installed) by the renter, with a trusted
// version, a high auto limit and an allowance: only the address can ask.
async function ready(payeeAddress: string, label = "Weftworks", paidBefore = true) {
  await post(exec(), { userId: renter.id, currency: "USDC", kind: "deposit", amount: usdc(100), key: `fund:addr:${++n}` });
  const inst = await installed(rt, renter, await publishedAgent(db, maker, { definition: paying() }));
  const policy = { autoSpendUsdc: 1000 };
  await db.update(schema.agentInstallations).set({ policy }).where(eq(schema.agentInstallations.id, inst.id));
  await topUp(rt, renter, inst.id, usdc(50), `addr-top-${++n}`);
  const payee = await savePayee(rt, renter, inst.id, { label, address: payeeAddress });
  if (paidBefore) await db.update(schema.payees).set({ firstPaidAt: rt.now() }).where(eq(schema.payees.id, payee.id));
  await trusted(rt, inst.versionId, 800);
  const job = await enqueue(rt, inst, { kind: "manual" });
  return { inst: { ...inst, policy }, job, payee };
}

const callPay = (inst: schema.AgentInstallation, job: schema.AgentJob, to: string, amountUsdc = 2) =>
  new JobTools(rt, inst, paying(), job).call(payStep(), "wallet.pay", { to, amountUsdc, memo: "Linen order" }, undefined, { inputs: {}, untrusted: [], callKey: `k${++n}` });
const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("what is known about an address", () => {
  it("flags the maker's own wallet, the treasury, another maker's wallet and an address many renters pay", async () => {
    const a = await ready(addr(0x101));
    await link(maker.id, addr(0x201));
    expect((await addressFacts(rt, addr(0x201), a.inst)).flags).toEqual(["maker_wallet"]);
    expect((await addressFacts(rt, rt.payments!.config.treasury!, a.inst)).flags).toEqual(["treasury"]);
    const otherMaker = await addUser(db, `addr.other.${++n}`);
    await publishedAgent(db, otherMaker);
    await link(otherMaker.id, addr(0x202));
    expect((await addressFacts(rt, addr(0x202), a.inst)).flags).toEqual(["other_maker"]);
    // Someone with a wallet who makes nothing is no one in particular.
    const plain = await addUser(db, `addr.plain.${++n}`);
    await link(plain.id, addr(0x203));
    expect((await addressFacts(rt, addr(0x203), a.inst)).flags).toEqual([]);
    // Three other renters saving the same address make it crowded.
    for (let k = 0; k < 3; k++) {
      const r = await addUser(db, `addr.crowd.${++n}`);
      const i = await installed(rt, r, await publishedAgent(db, maker));
      await savePayee(rt, r, i.id, { label: `Shop ${k}`, address: addr(0x204) });
      expect((await addressFacts(rt, addr(0x204), a.inst)).flags).toEqual(k < 2 ? [] : ["crowded"]);
    }
    expect((await addressFacts(rt, addr(0x204), a.inst)).otherRenters).toBe(3);
  });

  it("lets a renter who makes agents pay their own wallet without a flag", async () => {
    const own = await addUser(db, `addr.own.${++n}`);
    const inst = await installed(rt, own, await publishedAgent(db, own));
    await link(own.id, addr(0x301));
    expect((await addressFacts(rt, addr(0x301), inst)).flags).toEqual([]);
  });
});

describe("a payment to a high risk address", () => {
  it("always asks, with a plain warning, whatever the limits, the band or its history allow", async () => {
    await link(maker.id, addr(0x401));
    const { inst, job } = await ready(addr(0x401));
    const asked = (await err(callPay(inst, job, "Weftworks"))) as Paused;
    expect(asked).toBeInstanceOf(Paused);
    expect(asked.ask.reason).toMatch(new RegExp(`^Careful: ${FLAG_WORDS.maker_wallet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} A payment to this address always asks\\.`));
    // The safety check is told too.
    expect(rt.guarded.at(-1)).toContain(`Warning about the address: ${FLAG_WORDS.maker_wallet}`);
    // The renter's spending screen says so on the payee.
    const s = await spendingOf(rt, renter, inst.id);
    expect(s!.payees[0]!.warning).toBe(FLAG_WORDS.maker_wallet);
  });

  it("goes through without asking for an ordinary address within the limits", async () => {
    const { inst, job } = await ready(addr(0x402));
    expect(await callPay(inst, job, "Weftworks")).toMatchObject({ paid: true });
    const s = await spendingOf(rt, renter, inst.id);
    expect(s!.payees[0]).toMatchObject({ warning: null, paidBefore: true });
  });
});

describe("renaming a payee", () => {
  it("never changes what the safety check is asked, or its answer, for the same address", async () => {
    // The check answers by what it reads: a name like "Owner wallet" would sway it.
    rt.guardVerdict = (request) => (/owner wallet/i.test(request) ? { verdict: "block", reason: "Paying the owner's wallet isn't what it is for." } : { verdict: "allow", reason: "It fits." });
    const { inst, job } = await ready(addr(0x501), "Owner wallet");
    expect(await callPay(inst, job, "Owner wallet")).toMatchObject({ paid: true });
    const first = rt.guarded.at(-1)!;
    expect(first).not.toMatch(/owner wallet/i);
    expect(first).toContain(addr(0x501));
    // Renamed in place: the same payee, the same address.
    const renamed = await savePayee(rt, renter, inst.id, { label: "Weftworks", address: addr(0x501) });
    expect(renamed.label).toBe("Weftworks");
    expect(await callPay(inst, job, "Weftworks")).toMatchObject({ paid: true });
    const second = rt.guarded.at(-1)!;
    // Only what changes between payments (it has paid once more) differs.
    expect(second.replace(/paid it .*? before[^.]*\./, "")).toBe(first.replace(/paid it .*? before[^.]*\./, ""));
  });

  it("builds the check's request from the address, never the label", () => {
    const request = guardRequest({
      definition: { name: "Restock", job: { does: "Orders fabric.", done: "Ordered." }, actions: [] },
      step: payStep(),
      tool: "wallet.pay",
      risk: "money",
      args: { to: "My mum", amountUsdc: 3, memo: "Linen" },
      settings: {},
      inputs: {},
      untrusted: [],
      payment: { address: addr(0x601), amountUsdc: "3.00", memo: "Linen", paidBefore: 0, lastPaidAt: null, warning: null },
    } as never);
    expect(request).not.toContain("My mum");
    expect(request).toContain(addr(0x601));
    expect(request).toContain("This agent paid it never before.");
  });
});
