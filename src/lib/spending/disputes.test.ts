// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { balancesOf, post } from "@/lib/payments/ledger";
import { rent } from "@/lib/market/rentals";
import { moderate, moderationQueue } from "@/lib/safety/moderation";
import { versionTrust } from "@/lib/trust/trust";
import { makerDashboard } from "@/lib/market/dashboard";
import { savePayee } from "./payees";
import { decideDispute, DisputeRefused, disputesOf, DISPUTES_PER_30_DAYS, ledgerReady, MAX_OPEN_DISPUTES, openDispute, refundsWaiting } from "./disputes";

// Disputes: a renter's own payment or week of rent, within the window,
// with a reason and a note, a few at a time; an admin upholds or rejects.
// An upheld rent week is refunded through the ledger (the maker's share
// back as far as they still have it, the platform covering the rest, and
// the platform's fee); an upheld payment counts against the agent's score,
// since it can't be pulled back. Refunds wait for the ledger's new kinds.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let admin: schema.User;
let n = 0;

const usdc = (whole: number) => BigInt(Math.round(whole * 1e6));
const exec = () => db as never;
const NOTE = "It didn't restock anything that week.";

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "dispute.maker", "dispute_maker");
  admin = await addUser(db, "dispute.admin", "dispute_admin");
});
afterAll(async () => client.close());
beforeEach(() => {
  rt = testRuntime(db);
});

async function renter(): Promise<schema.User> {
  const u = await addUser(db, `dispute.renter.${++n}`, `dispute_renter_${n}`);
  await post(exec(), { userId: u.id, currency: "USDC", kind: "deposit", amount: usdc(50), key: `fund:dispute:${n}` });
  return u;
}

// A rental whose first week (10 USDC: 9 to the maker, 1 to the platform)
// is paid at once.
async function rented(u: schema.User) {
  const p = await publishedAgent(db, maker);
  await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: usdc(10).toString(), jobFee: "0", listed: true });
  const r = await rent(rt, { renterUserId: u.id, agentId: p.agent.id });
  return { ...p, rental: r };
}

// A payment its agent made, confirmed on chain (or another status).
async function paid(u: schema.User, status: schema.AgentPayment["status"] = "confirmed", daysAgo = 1) {
  const p = await publishedAgent(db, maker);
  const inst = await installed(rt, u, p);
  const payee = await savePayee(rt, u, inst.id, { label: "Weftworks", address: "0x0000000000000000000000000000000000000000" });
  const at = new Date(rt.now().getTime() - daysAgo * 86_400_000);
  const [row] = await db
    .insert(schema.agentPayments)
    .values({ key: `dispute:pay:${++n}`, installationId: inst.id, agentId: p.agent.id, versionId: p.version.id, ownerUserId: u.id, payeeId: payee.id, payeeLabel: "Weftworks", toAddress: payee.address, amount: usdc(4).toString(), chainId: 84532, status, settledAt: status === "confirmed" ? at : null, createdAt: at, updatedAt: at })
    .returning();
  return { ...p, inst, payment: row! };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as DisputeRefused);
const platformTotal = async () => (await db.select().from(schema.ledgerEntries).where(isNull(schema.ledgerEntries.userId))).reduce((t, e) => t + BigInt(e.amount), 0n);

describe("opening a dispute", () => {
  it("disputes the renter's own payment or week of rent, once, and puts it in the admin queue", async () => {
    const u = await renter();
    const r = await rented(u);
    const p = await paid(u);
    const before = await disputesOf(rt, u.id);
    expect(before.disputable.map((d) => d.kind).sort()).toEqual(["payment", "rent"]);
    expect(before.disputable.find((d) => d.kind === "payment")!.what).toMatch(/^4\.00 USDC to Weftworks on \d{4}-\d{2}-\d{2}$/);
    await openDispute(rt, u, { kind: "rent", id: `${r.rental.id}:1`, reason: "not_working", note: NOTE });
    await openDispute(rt, u, { kind: "payment", id: p.payment.id, reason: "not_done", note: "It paid for linen that never came." });
    const after = await disputesOf(rt, u.id);
    expect(after.disputable).toEqual([]);
    expect(after.disputes.map((d) => [d.kind, d.status, d.reasonWords])).toEqual([
      ["payment", "open", "It paid for something that wasn't done"],
      ["rent", "open", "The agent didn't work that week"],
    ]);
    expect((await refusal(openDispute(rt, u, { kind: "rent", id: `${r.rental.id}:1`, reason: "other", note: NOTE })))!.status).toBe(409);
    const q = await moderationQueue(rt);
    expect(q.disputes.open.filter((d) => d.renter === `@${u.handle}`).map((d) => d.kind).sort()).toEqual(["payment", "rent"]);
    expect(q.disputes.ledgerReady).toBe(true);
  });

  it("refuses someone else's, one that never went out, one past the window, and odd ids", async () => {
    const u = await renter();
    const other = await renter();
    const theirs = await paid(other);
    expect((await refusal(openDispute(rt, u, { kind: "payment", id: theirs.payment.id, reason: "not_done", note: NOTE })))!.status).toBe(404);
    const failed = await paid(u, "failed");
    expect((await refusal(openDispute(rt, u, { kind: "payment", id: failed.payment.id, reason: "not_done", note: NOTE })))!.message).toMatch(/never went out/);
    const old = await paid(u, "confirmed", 15);
    expect((await refusal(openDispute(rt, u, { kind: "payment", id: old.payment.id, reason: "not_done", note: NOTE })))!.message).toMatch(/older than 14 days/);
    const r = await rented(other);
    for (const id of [`${r.rental.id}:1`, `${r.rental.id}:0`, `${r.rental.id}:x`, "not-an-id", "'; drop table disputes; --", `${r.rental.id}`]) {
      expect((await refusal(openDispute(rt, u, { kind: "rent", id, reason: "not_working", note: NOTE })))!.status, id).toBe(404);
    }
  });

  it("needs a reason that fits and a note of a sensible length", async () => {
    const u = await renter();
    const p = await paid(u);
    for (const [reason, note] of [["not_working", NOTE], ["refund_me", NOTE], ["not_done", "short"], ["not_done", "x".repeat(1001)], ["not_done", "          "]]) {
      expect((await refusal(openDispute(rt, u, { kind: "payment", id: p.payment.id, reason: reason!, note: note! })))!.status, `${reason} ${note!.length}`).toBe(400);
    }
    expect((await refusal(openDispute(rt, u, { kind: "steal" as never, id: p.payment.id, reason: "other", note: NOTE })))!.status).toBe(400);
  });

  it("allows a few open at a time, and a few a month, per renter", async () => {
    const u = await renter();
    const pays = [];
    for (let i = 0; i < DISPUTES_PER_30_DAYS + 1; i++) pays.push(await paid(u));
    for (let i = 0; i < MAX_OPEN_DISPUTES; i++) await openDispute(rt, u, { kind: "payment", id: pays[i]!.payment.id, reason: "not_done", note: NOTE });
    const tooMany = await refusal(openDispute(rt, u, { kind: "payment", id: pays[MAX_OPEN_DISPUTES]!.payment.id, reason: "not_done", note: NOTE }));
    expect(tooMany!.status).toBe(429);
    expect(tooMany!.message).toMatch(/3 disputes waiting already/);
    // Decided ones free a place, but not past the month's limit.
    for (const d of (await disputesOf(rt, u.id)).disputes) await decideDispute(rt, admin, d.id, "reject", "Looked fine.");
    for (let i = MAX_OPEN_DISPUTES; i < DISPUTES_PER_30_DAYS; i++) {
      await openDispute(rt, u, { kind: "payment", id: pays[i]!.payment.id, reason: "not_done", note: NOTE });
      for (const d of (await disputesOf(rt, u.id)).disputes.filter((x) => x.status === "open")) await decideDispute(rt, admin, d.id, "reject", "Looked fine.");
    }
    const month = await refusal(openDispute(rt, u, { kind: "payment", id: pays[DISPUTES_PER_30_DAYS]!.payment.id, reason: "not_done", note: NOTE }));
    expect(month!.status).toBe(429);
    expect(month!.message).toMatch(/6 disputes in 30 days/);
  });
});

describe("deciding a dispute", () => {
  it("refunds an upheld week of rent: the renter's money back, the maker's and platform's shares reversed", async () => {
    const u = await renter();
    const r = await rented(u);
    expect((await balancesOf(u.id, exec())).USDC.available).toBe(usdc(40));
    const makerBefore = (await balancesOf(maker.id, exec())).USDC.available;
    const platformBefore = await platformTotal();
    const d = await openDispute(rt, u, { kind: "rent", id: `${r.rental.id}:1`, reason: "not_working", note: NOTE });
    const done = (await decideDispute(rt, admin, d.id, "uphold", "It was down all week."))!;
    expect(done).toMatchObject({ status: "upheld", resolution: "Upheld: It was down all week.", refund: "done", makerReversed: usdc(9).toString(), platformReversed: usdc(1).toString() });
    expect((await balancesOf(u.id, exec())).USDC.available).toBe(usdc(50));
    expect((await balancesOf(maker.id, exec())).USDC.available).toBe(makerBefore - usdc(9));
    expect(await platformTotal()).toBe(platformBefore - usdc(1));
    // Once: deciding again changes nothing.
    expect(await decideDispute(rt, admin, d.id, "uphold", "Again.")).toBeNull();
    expect(await refundsWaiting(rt)).toBe(0);
    expect((await balancesOf(u.id, exec())).USDC.available).toBe(usdc(50));
    // The maker's dashboard no longer counts the week's share.
    const dash = await makerDashboard(rt, r.agent);
    expect(dash.earnings.reduce((t, w) => t + BigInt(w.amount), 0n)).toBe(0n);
    // It counts against the version's score as a refund.
    const t = (await versionTrust(rt, [r.version.id])).get(r.version.id)!;
    expect(t.factors.find((f) => f.key === "refunds")).toMatchObject({ points: -30, words: "1 week of rent refunded" });
  });

  it("has the platform cover what the maker has already withdrawn", async () => {
    const solo = await addUser(db, `dispute.solo.${++n}`, `dispute_solo_${n}`);
    const u = await renter();
    const p = await publishedAgent(db, solo);
    await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: usdc(10).toString(), jobFee: "0", listed: true });
    const r = await rent(rt, { renterUserId: u.id, agentId: p.agent.id });
    // The maker took 5 of their 9 out.
    await post(exec(), { userId: solo.id, currency: "USDC", kind: "withdrawal", amount: -usdc(5), key: `out:${solo.id}` });
    const platformBefore = await platformTotal();
    const d = await openDispute(rt, u, { kind: "rent", id: `${r.id}:1`, reason: "not_working", note: NOTE });
    const done = (await decideDispute(rt, admin, d.id, "uphold", "It never ran."))!;
    expect(done).toMatchObject({ refund: "done", makerReversed: usdc(4).toString(), platformReversed: usdc(6).toString() });
    expect((await balancesOf(solo.id, exec())).USDC.available).toBe(0n);
    expect((await balancesOf(u.id, exec())).USDC.available).toBe(usdc(50));
    expect(await platformTotal()).toBe(platformBefore - usdc(6));
  });

  it("can't pull back an upheld payment: it counts against the agent's score, and the renter is told plainly", async () => {
    const u = await renter();
    const p = await paid(u);
    const before = (await balancesOf(u.id, exec())).USDC.available;
    const d = await openDispute(rt, u, { kind: "payment", id: p.payment.id, reason: "wrong_payee", note: "It paid the old supplier." });
    const done = (await decideDispute(rt, admin, d.id, "uphold", "The payee was out of date."))!;
    expect(done).toMatchObject({ status: "upheld", refund: "none" });
    expect((await balancesOf(u.id, exec())).USDC.available).toBe(before);
    const [m] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, p.inst.id));
    expect(m!.text).toBe(`Your dispute of a 4.00 USDC payment by ${p.agent.name} was upheld: The payee was out of date. The payment can't be pulled back on Base, so it counts against ${p.agent.name}'s trust score.`);
    const t = (await versionTrust(rt, [p.version.id])).get(p.version.id)!;
    expect(t.factors.find((f) => f.key === "disputes")).toMatchObject({ points: -50, words: "1 dispute upheld this month" });
  });

  it("moves nothing when rejected, and tells the renter why", async () => {
    const u = await renter();
    const p = await paid(u);
    const d = await openDispute(rt, u, { kind: "payment", id: p.payment.id, reason: "not_wanted", note: "I never meant it to pay." });
    expect(await moderate(rt, admin, { type: "dispute", id: d.id }, "reject", "You approved it on 8 Nov.")).toBe(true);
    const [m] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, p.inst.id));
    expect(m!.text).toBe(`Your dispute of a 4.00 USDC payment by ${p.agent.name} wasn't upheld: You approved it on 8 Nov.`);
    expect((await versionTrust(rt, [p.version.id])).get(p.version.id)!.factors.find((f) => f.key === "disputes")).toBeUndefined();
  });

  it("takes only uphold or reject for a dispute, and neither for anything else", async () => {
    const u = await renter();
    const p = await paid(u);
    const d = await openDispute(rt, u, { kind: "payment", id: p.payment.id, reason: "not_done", note: NOTE });
    for (const action of ["approve", "hide", "freeze"] as const) expect(await moderate(rt, admin, { type: "dispute", id: d.id }, action, "Some reason.")).toBe(false);
    expect(await moderate(rt, admin, { type: "report", id: d.id }, "uphold", "Some reason.")).toBe(false);
    expect(await moderate(rt, admin, { type: "dispute", id: "nope" }, "uphold", "Some reason.")).toBe(false);
    expect((await db.select().from(schema.disputes).where(eq(schema.disputes.id, d.id)))[0]!.status).toBe("open");
  });
});

describe("refunds before the ledger can take them", () => {
  it("wait until the owner's SQL has run, then the worker refunds them once", async () => {
    // The database as a deploy's push leaves it: the old checks (not
    // checked against the refunds the tests above made).
    await client.exec(`
      ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_kind";
      ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_sign";
      ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_platform";
      ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_kind" CHECK ("ledger_entries"."kind" in ('deposit', 'use_charge', 'maker_earning', 'platform_fee', 'withdrawal', 'withdrawal_reversal')) NOT VALID;
      ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_sign" CHECK (("ledger_entries"."kind" in ('use_charge', 'withdrawal')) = ("ledger_entries"."amount" like '-%')) NOT VALID;
      ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_platform" CHECK (("ledger_entries"."kind" = 'platform_fee') = ("ledger_entries"."user_id" is null)) NOT VALID;
    `);
    expect(await ledgerReady(exec())).toBe(false);
    const u = await renter();
    const r = await rented(u);
    const d = await openDispute(rt, u, { kind: "rent", id: `${r.rental.id}:1`, reason: "not_working", note: NOTE });
    expect(await decideDispute(rt, admin, d.id, "uphold", "Down all week.")).toMatchObject({ status: "upheld", refund: "waiting" });
    expect(await refundsWaiting(rt)).toBe(0);
    expect((await balancesOf(u.id, exec())).USDC.available).toBe(usdc(40));
    expect((await moderationQueue(rt)).disputes).toMatchObject({ waiting: 1, ledgerReady: false });
    // The owner runs scripts/sql/ledger-kinds.sql (twice: it's safe to).
    const script = readFileSync(join(process.cwd(), "scripts/sql/ledger-kinds.sql"), "utf8");
    await client.exec(script);
    await client.exec(script);
    expect(await ledgerReady(exec())).toBe(true);
    expect(await refundsWaiting(rt)).toBe(1);
    expect(await refundsWaiting(rt)).toBe(0);
    expect((await balancesOf(u.id, exec())).USDC.available).toBe(usdc(50));
    const refunds = await db.select().from(schema.ledgerEntries).where(and(eq(schema.ledgerEntries.kind, "refund"), eq(schema.ledgerEntries.userId, u.id)));
    expect(refunds).toHaveLength(1);
  });
});
