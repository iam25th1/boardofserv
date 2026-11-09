import "server-only";
import { and, desc, eq, inArray, lte, ne } from "drizzle-orm";
import { agentInstallations, agentListings, agents, agentVersions, rentalCharges, rentals, users, type Rental } from "../db/schema";
import type { RentalDTO } from "../types";
import { setupShapeOf, type SetupShape } from "../agents/definition";
import type { Exec } from "../payments/ledger";
import { control, install, loadInstallation } from "../agents/runtime/installations";
import type { Runtime } from "../agents/runtime/context";
import type { InstallAnswers } from "../agents/settingsForm";
import { capture, holdFor, usdc, USDC_DECIMALS } from "./charges";

// Renting an agent by the week.
//
// Renting charges the first week at once from the renter's balance (held,
// then captured: 90% to the maker, 10% to the platform; see charges.ts).
// Then the renter sets it up with the guided setup, as its owner. Each
// week after renews from the worker's cycle while the balance covers it;
// when it doesn't, the rental is unpaid and its installation pauses,
// saying how much is due and that a top-up and a resume set it going
// again. Cancelling stops renewal: it runs to the end of the week already
// paid for, then stops. A week is never charged twice (rental_charges).

export const WEEK_MS = 7 * 86_400_000;

export class RentRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "RentRefused";
  }
}

// One week of a rental, charged once: "paid" (free counts), or "short"
// when the balance doesn't cover it (and nothing changes).
async function chargeWeek(tx: Exec, r: Rental, week: number): Promise<"paid" | "short"> {
  const [done] = await tx.select().from(rentalCharges).where(and(eq(rentalCharges.rentalId, r.id), eq(rentalCharges.week, week)));
  if (done) return "paid";
  const amount = BigInt(r.weeklyPrice);
  let holdId: string | null = null;
  if (amount > 0n) {
    holdId = await holdFor(tx, { renterUserId: r.renterUserId, makerUserId: r.makerUserId, amount, kind: "rent" });
    if (!holdId) return "short";
    await capture(tx, holdId);
  }
  await tx.insert(rentalCharges).values({ rentalId: r.id, week, amount: amount.toString(), holdId });
  return "paid";
}

export interface RentTerms {
  weeklyPrice: string;
  jobFee: string;
}

// Rents an agent on the board for someone: the first week charged now.
// terms: a price agreed on the request board, else the listing's.
export async function rent(rt: Runtime, o: { renterUserId: string; agentId: string; terms?: RentTerms }): Promise<Rental> {
  if (!/^[0-9a-f-]{36}$/i.test(o.agentId)) throw new RentRefused("It isn't on the board to rent.", 404);
  const [row] = await rt.db
    .select({ listing: agentListings, makerId: agents.ownerUserId, state: agentVersions.state })
    .from(agentListings)
    .innerJoin(agents, eq(agents.id, agentListings.agentId))
    .innerJoin(agentVersions, eq(agentVersions.id, agentListings.versionId))
    .where(eq(agentListings.agentId, o.agentId));
  if (!row || !row.listing.listed || row.state !== "published") throw new RentRefused("It isn't on the board to rent.", 404);
  if (row.makerId === o.renterUserId) throw new RentRefused("It's yours: run it from its builder, with Run it for real.", 409);
  const [already] = await rt.db
    .select({ id: rentals.id })
    .from(rentals)
    .where(and(eq(rentals.agentId, o.agentId), eq(rentals.renterUserId, o.renterUserId), ne(rentals.status, "ended")));
  if (already) throw new RentRefused("You rent it already: it's under Rented.", 409);
  const terms = o.terms ?? { weeklyPrice: row.listing.weeklyPrice, jobFee: row.listing.jobFee };
  const now = rt.now();
  return rt.db.transaction(async (tx) => {
    const [r] = await tx
      .insert(rentals)
      .values({
        agentId: o.agentId,
        versionId: row.listing.versionId,
        renterUserId: o.renterUserId,
        makerUserId: row.makerId,
        weeklyPrice: terms.weeklyPrice,
        jobFee: terms.jobFee,
        paidUntil: new Date(now.getTime() + WEEK_MS),
        weeksPaid: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if ((await chargeWeek(tx, r!, 1)) === "short") {
      throw new RentRefused(`The first week is ${usdc(terms.weeklyPrice)}, and your balance doesn't cover it. Top up your wallet, then rent it.`, 402);
    }
    return r!;
  });
}

// A renter's own rental, or null (anyone else's reads as not there).
export async function rentalOf(rt: Runtime, renterUserId: string, id: string): Promise<Rental | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await rt.db.select().from(rentals).where(and(eq(rentals.id, id), eq(rentals.renterUserId, renterUserId)));
  return r ?? null;
}

// The renter sets it up, as its owner: installed, not live until they say.
export async function installRental(rt: Runtime, r: Rental, answers: InstallAnswers): Promise<string> {
  if (r.status === "ended") throw new RentRefused("This rental has ended. Rent it again from the board.", 409);
  if (r.installationId) {
    const existing = await loadInstallation(rt, r.installationId);
    if (existing && existing.installation.status !== "stopped") throw new RentRefused("It's set up already.", 409);
  }
  const [row] = await rt.db
    .select({ agent: agents, version: agentVersions })
    .from(agents)
    .innerJoin(agentVersions, eq(agentVersions.id, r.versionId))
    .where(eq(agents.id, r.agentId));
  if (!row) throw new RentRefused("Its agent isn't there any more.", 404);
  const inst = await install(rt, { ownerUserId: r.renterUserId, agent: row.agent, version: row.version, answers, live: false });
  await rt.db.update(rentals).set({ installationId: inst.id, updatedAt: rt.now() }).where(eq(rentals.id, r.id));
  return inst.id;
}

export const RENT_SHORT = (price: string) => `This week's rent of ${usdc(price)} couldn't be paid: your balance is too low. Top up your wallet, then resume it from Rented.`;

async function endRental(rt: Runtime, r: Rental): Promise<boolean> {
  const [ended] = await rt.db
    .update(rentals)
    .set({ status: "ended", updatedAt: rt.now() })
    .where(and(eq(rentals.id, r.id), ne(rentals.status, "ended")))
    .returning({ id: rentals.id });
  if (ended && r.installationId) {
    const l = await loadInstallation(rt, r.installationId);
    if (l && l.installation.status !== "stopped") await control(rt, l, "stop");
  }
  return Boolean(ended);
}

// From the worker's cycle: rentals whose paid week is over. A cancelled
// one ends (its installation stops); the rest renew, or go unpaid and
// pause when the balance is short. Returns how many changed.
export async function renewDue(rt: Runtime, limit = 50): Promise<number> {
  const now = rt.now();
  const due = await rt.db
    .select()
    .from(rentals)
    .where(and(eq(rentals.status, "active"), lte(rentals.paidUntil, now)))
    .limit(limit);
  let changed = 0;
  for (const r of due) {
    if (!r.renews) {
      if (await endRental(rt, r)) changed += 1;
      continue;
    }
    const how = await rt.db.transaction(async (tx) => {
      // Still as read: another cycle may have renewed it.
      const [fresh] = await tx.select().from(rentals).where(and(eq(rentals.id, r.id), eq(rentals.status, "active"), eq(rentals.weeksPaid, r.weeksPaid)));
      if (!fresh) return null;
      const week = fresh.weeksPaid + 1;
      const charged = await chargeWeek(tx, fresh, week);
      if (charged === "paid") await tx.update(rentals).set({ weeksPaid: week, paidUntil: new Date(fresh.paidUntil.getTime() + WEEK_MS), updatedAt: now }).where(eq(rentals.id, r.id));
      else await tx.update(rentals).set({ status: "unpaid", updatedAt: now }).where(eq(rentals.id, r.id));
      return charged;
    });
    if (how === "short" && r.installationId) {
      await rt.db
        .update(agentInstallations)
        .set({ status: "paused", pausedReason: RENT_SHORT(r.weeklyPrice), updatedAt: now })
        .where(and(eq(agentInstallations.id, r.installationId), eq(agentInstallations.status, "active")));
    }
    if (how) changed += 1;
  }
  return changed;
}

export const RENTAL_ACTIONS = ["pause", "resume", "cancel", "renew"] as const;
export type RentalAction = (typeof RENTAL_ACTIONS)[number];

// The renter's controls on a rental.
// - pause, resume: its installation. Resuming an unpaid rental pays this
//   week first, and its next week starts from now.
// - cancel: no more renewals; it runs to the end of the week paid for (an
//   unpaid one has none left, so it ends now).
// - renew: undoes a cancel while the paid week runs.
export async function rentalControl(rt: Runtime, r: Rental, action: RentalAction): Promise<void> {
  const now = rt.now();
  if (r.status === "ended") throw new RentRefused("This rental has ended. Rent it again from the board.", 409);
  if (action === "cancel") {
    if (r.status === "unpaid") {
      await endRental(rt, r);
      return;
    }
    if (!r.renews) throw new RentRefused("It's cancelled already: it stops when the week you paid for ends.", 409);
    await rt.db.update(rentals).set({ renews: false, cancelledAt: now, updatedAt: now }).where(eq(rentals.id, r.id));
    return;
  }
  if (action === "renew") {
    if (r.renews) throw new RentRefused("It renews already.", 409);
    await rt.db.update(rentals).set({ renews: true, cancelledAt: null, updatedAt: now }).where(eq(rentals.id, r.id));
    return;
  }
  const l = r.installationId ? await loadInstallation(rt, r.installationId) : null;
  if (!l || l.installation.status === "stopped") throw new RentRefused("Set it up first.", 409);
  if (action === "pause") {
    await control(rt, l, "pause");
    return;
  }
  if (r.status === "unpaid") {
    const how = await rt.db.transaction(async (tx) => {
      const [fresh] = await tx.select().from(rentals).where(and(eq(rentals.id, r.id), eq(rentals.status, "unpaid")));
      if (!fresh) return "paid" as const;
      const week = fresh.weeksPaid + 1;
      const charged = await chargeWeek(tx, fresh, week);
      if (charged === "paid") await tx.update(rentals).set({ status: "active", weeksPaid: week, paidUntil: new Date(now.getTime() + WEEK_MS), updatedAt: now }).where(eq(rentals.id, r.id));
      return charged;
    });
    if (how === "short") throw new RentRefused(`This week's rent is ${usdc(r.weeklyPrice)}, and your balance doesn't cover it. Top up your wallet, then resume it.`, 402);
  }
  if (l.installation.status === "paused") await control(rt, l, "resume");
}

// What the renter sees of their rentals: newest first, ended ones last.
export async function rentalsOf(rt: Runtime, renterUserId: string): Promise<RentalDTO[]> {
  const rows = await rt.db.select().from(rentals).where(eq(rentals.renterUserId, renterUserId)).orderBy(desc(rentals.createdAt)).limit(100);
  const out = await rentalDTOs(rt, rows);
  return [...out.filter((r) => r.status !== "ended"), ...out.filter((r) => r.status === "ended")];
}

export async function rentalDTOs(rt: Runtime, rows: Rental[]): Promise<RentalDTO[]> {
  if (!rows.length) return [];
  const about = await rt.db
    .select({ versionId: agentVersions.id, number: agentVersions.number, definition: agentVersions.definition, name: agents.name, maker: users.handle })
    .from(agentVersions)
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .innerJoin(users, eq(users.id, agents.ownerUserId))
    .where(inArray(agentVersions.id, [...new Set(rows.map((r) => r.versionId))]));
  const installIds = rows.flatMap((r) => (r.installationId ? [r.installationId] : []));
  const installs = installIds.length
    ? await rt.db
        .select({ id: agentInstallations.id, status: agentInstallations.status, live: agentInstallations.live, pausedReason: agentInstallations.pausedReason })
        .from(agentInstallations)
        .where(inArray(agentInstallations.id, installIds))
    : [];
  return rows.map((r) => {
    const a = about.find((x) => x.versionId === r.versionId);
    const i = installs.find((x) => x.id === r.installationId);
    const set = i && i.status !== "stopped";
    const status: RentalDTO["status"] =
      r.status === "ended"
        ? "ended"
        : r.status === "unpaid"
          ? "unpaid"
          : !set
            ? "setup"
            : !r.renews
              ? "cancelling"
              : !i.live
                ? "testing"
                : i.status === "paused"
                  ? "paused"
                  : "active";
    return {
      id: r.id,
      agentId: r.agentId,
      name: a?.definition?.name ?? a?.name ?? "An agent",
      does: a?.definition?.job.does ?? "",
      maker: a?.maker ?? "",
      version: a?.number ?? 0,
      status,
      pausedReason: i?.status === "paused" ? i.pausedReason : null,
      weeklyPrice: r.weeklyPrice,
      jobFee: r.jobFee,
      decimals: USDC_DECIMALS,
      paidUntil: r.paidUntil.toISOString(),
      renews: r.renews,
      weeksPaid: r.weeksPaid,
      installationId: set ? r.installationId : null,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

// What setting a rental up needs of its agent, and no more.
export async function rentalSetup(rt: Runtime, r: Rental): Promise<SetupShape | null> {
  const [v] = await rt.db.select({ definition: agentVersions.definition }).from(agentVersions).where(eq(agentVersions.id, r.versionId));
  return v?.definition ? setupShapeOf(v.definition) : null;
}
