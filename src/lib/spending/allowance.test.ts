// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { balancesOf, ledgerTotal, post } from "@/lib/payments/ledger";
import { control, loadInstallation } from "@/lib/agents/runtime/installations";
import { freeze } from "@/lib/safety/freeze";
import { allowanceOf, AllowanceRefused, holdForPayment, readUsdc, releasePayment, spendPayment, topUp, withdrawAllowance } from "./allowance";

// Spending allowances: each installation's own, funded from its renter's
// balance and taken back at any time; the money stays the renter's, held.
// Nobody else's installation, a balance that doesn't cover it, a frozen
// renter or a stopped installation is refused. Every change happens once
// by its key.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let renter: schema.User;
let other: schema.User;
let n = 0;

const exec = () => db as never;
const usdc = (whole: number) => BigInt(Math.round(whole * 1e6));
const fund = (u: schema.User, whole: number) => post(exec(), { userId: u.id, currency: "USDC", kind: "deposit", amount: usdc(whole), key: `fund:${u.id}:${++n}` });
const key = () => `key-${++n}-abcdef`;

beforeAll(async () => {
  ({ client, db } = await testDb());
  renter = await addUser(db, "allowance.renter");
  other = await addUser(db, "allowance.other");
});
afterAll(async () => client.close());
beforeEach(() => {
  rt = testRuntime(db);
});

async function inst(owner = renter) {
  return installed(rt, owner, await publishedAgent(db, owner));
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as AllowanceRefused);

describe("a spending allowance", () => {
  it("moves money from the renter's balance into it and back, the total unchanged", async () => {
    await fund(renter, 20);
    const i = await inst();
    const before = await ledgerTotal(renter.id, "USDC", exec());
    expect(await topUp(rt, renter, i.id, usdc(8), key())).toEqual({ available: usdc(8), held: 0n });
    expect((await balancesOf(renter.id, exec())).USDC).toMatchObject({ available: usdc(12), held: usdc(8) });
    expect(await withdrawAllowance(rt, renter, i.id, usdc(3), key())).toEqual({ available: usdc(5), held: 0n });
    expect(await withdrawAllowance(rt, renter, i.id, "all", key())).toEqual({ available: 0n, held: 0n });
    expect((await balancesOf(renter.id, exec())).USDC).toMatchObject({ available: usdc(20), held: 0n });
    expect(await ledgerTotal(renter.id, "USDC", exec())).toBe(before);
  });

  it("happens once by its key", async () => {
    await fund(renter, 10);
    const i = await inst();
    const k = key();
    await topUp(rt, renter, i.id, usdc(4), k);
    await topUp(rt, renter, i.id, usdc(4), k);
    expect(await allowanceOf(exec(), i.id)).toEqual({ available: usdc(4), held: 0n });
    const w = key();
    await withdrawAllowance(rt, renter, i.id, usdc(1), w);
    await withdrawAllowance(rt, renter, i.id, usdc(1), w);
    expect((await allowanceOf(exec(), i.id)).available).toBe(usdc(3));
  });

  it("is the renter's own: another renter, a bad id, a stopped installation or a frozen renter is refused", async () => {
    await fund(other, 10);
    const i = await inst();
    expect((await refusal(topUp(rt, other, i.id, usdc(1), key())))?.status).toBe(404);
    expect((await refusal(withdrawAllowance(rt, other, i.id, "all", key())))?.status).toBe(404);
    expect((await refusal(topUp(rt, renter, "nope", usdc(1), key())))?.status).toBe(404);
    const stopped = await inst();
    await control(rt, (await loadInstallation(rt, stopped.id))!, "stop");
    expect((await refusal(topUp(rt, renter, stopped.id, usdc(1), key())))?.status).toBe(409);
    const frozenRenter = await addUser(db, "allowance.frozen");
    await fund(frozenRenter, 10);
    const fi = await inst(frozenRenter);
    await freeze(rt, other, "renter", frozenRenter.id, "Disputed deposits.");
    expect((await refusal(topUp(rt, frozenRenter, fi.id, usdc(1), key())))?.message).toMatch(/froze this account/);
  });

  it("can't take more than the renter has, more than it holds, or past its maximum", async () => {
    const poor = await addUser(db, "allowance.poor");
    await fund(poor, 2);
    const i = await inst(poor);
    expect((await refusal(topUp(rt, poor, i.id, usdc(3), key())))?.message).toMatch(/doesn't cover 3.00 USDC/);
    await topUp(rt, poor, i.id, usdc(2), key());
    expect((await refusal(withdrawAllowance(rt, poor, i.id, usdc(5), key())))?.message).toMatch(/has 2.00 USDC you can take back/);
    const rich = await addUser(db, "allowance.rich");
    await fund(rich, 500);
    const r = await inst(rich);
    expect((await refusal(topUp(rt, rich, r.id, usdc(101), key())))?.message).toMatch(/at most 100.00 USDC/);
    expect((await balancesOf(rich.id, exec())).USDC.available).toBe(usdc(500));
  });

  it("holds, releases and spends for a payment, once each, and spends never more than it holds", async () => {
    await fund(renter, 10);
    const i = await inst();
    await topUp(rt, renter, i.id, usdc(5), key());
    const at = rt.now();
    const p = { installationId: i.id, ownerUserId: renter.id, paymentId: "00000000-0000-4000-8000-0000000000a1", at };
    expect(await holdForPayment(exec(), { ...p, amount: usdc(6) })).toBe(false);
    expect(await holdForPayment(exec(), { ...p, amount: usdc(2) })).toBe(true);
    expect(await allowanceOf(exec(), i.id)).toEqual({ available: usdc(3), held: usdc(2) });
    // Withdrawing can't touch what a payment in flight holds.
    expect(await withdrawAllowance(rt, renter, i.id, "all", key())).toEqual({ available: 0n, held: usdc(2) });
    const total = await ledgerTotal(renter.id, "USDC", exec());
    expect(await spendPayment(exec(), { ...p, amount: usdc(2) })).toBe(true);
    expect(await spendPayment(exec(), { ...p, amount: usdc(2) })).toBe(false);
    expect(await allowanceOf(exec(), i.id)).toEqual({ available: 0n, held: 0n });
    expect(await ledgerTotal(renter.id, "USDC", exec())).toBe(total - usdc(2));
    const [charge] = await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.idempotencyKey, `agentpay:${p.paymentId}`));
    expect(charge).toMatchObject({ kind: "use_charge", amount: (-usdc(2)).toString() });
    // A release for a payment never held, or held by another installation, changes nothing.
    await topUp(rt, renter, i.id, usdc(1), key());
    const q = { ...p, paymentId: "00000000-0000-4000-8000-0000000000a2" };
    expect(await holdForPayment(exec(), { ...q, amount: usdc(1) })).toBe(true);
    expect(await releasePayment(exec(), { ...q, amount: usdc(1) })).toBe(true);
    expect(await releasePayment(exec(), { ...q, amount: usdc(1) })).toBe(false);
    expect(await allowanceOf(exec(), i.id)).toEqual({ available: usdc(1), held: 0n });
    const theirs = await inst(other);
    expect(await holdForPayment(exec(), { ...q, installationId: theirs.id, paymentId: "00000000-0000-4000-8000-0000000000a3", amount: usdc(1) })).toBe(false);
  });

  it("goes back to its renter when the installation stops", async () => {
    await fund(renter, 10);
    const i = await inst();
    await topUp(rt, renter, i.id, usdc(4), key());
    const before = (await balancesOf(renter.id, exec())).USDC.available;
    await control(rt, (await loadInstallation(rt, i.id))!, "stop");
    expect(await allowanceOf(exec(), i.id)).toEqual({ available: 0n, held: 0n });
    expect((await balancesOf(renter.id, exec())).USDC.available).toBe(before + usdc(4));
  });

  it("reads amounts as typed, in minor units, and nothing else", () => {
    expect(readUsdc("5")).toBe(5_000_000n);
    expect(readUsdc(" 2.50 ")).toBe(2_500_000n);
    expect(readUsdc("0.000001")).toBe(1n);
    for (const bad of ["0", "-1", "1.0000001", "1e3", "abc", "", "1,5", 5]) expect(readUsdc(bad), String(bad)).toBeNull();
  });
});
