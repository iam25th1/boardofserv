// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { balancesOf, post } from "@/lib/payments/ledger";
import { acceptOffer, closeRequest, makeOffer, meToo, OPEN_REQUESTS_MAX, postRequest, requestBoard, requestPage, RequestRefused, requestsOf, withdrawOffer } from "./requests";

// The request board on the real migrations: asking, "me too", offers,
// accepting one (which rents its agent at the offer's price through the
// ledger) and closing.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let asker: schema.User;
let maker: schema.User;
const usdc = (whole: number) => BigInt(Math.round(whole * 1e6));

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
  asker = await addUser(db, "req.asker", "sam_rivera");
  maker = await addUser(db, "req.maker", "lena_k");
  await post(db as never, { userId: asker.id, currency: "USDC", kind: "deposit", amount: usdc(30), key: `fund:${asker.id}` });
});
afterAll(async () => client.close());

const ask = (need: string, o: Partial<Parameters<typeof postRequest>[2]> = {}) => postRequest(rt, asker.id, { need, detail: "", connects: ["sheets"], budget: usdc(5), ...o });

describe("asking for an agent", () => {
  it("posts a request others can say me too to, sorted by most wanted or newest", async () => {
    const quiet = await ask("Tidy my invoices tab every Friday");
    rt.clock.move(60_000);
    const wanted = await ask("Remind customers about unpaid invoices", { detail: "From a sheet of invoices, a polite reminder a week after the due date.", connects: ["sheets", "telegram", "sheets"] as never });
    for (const who of ["req.a", "req.b"]) await meToo(rt, (await addUser(db, who)).id, wanted.id, true);
    const again = await addUser(db, "req.c");
    await meToo(rt, again.id, quiet.id, true);
    await meToo(rt, again.id, quiet.id, true);
    const board = await requestBoard(rt, { viewerId: again.id });
    expect(board.map((r) => [r.need, r.meToo])).toEqual([
      ["Remind customers about unpaid invoices", 2],
      ["Tidy my invoices tab every Friday", 1],
    ]);
    expect(board[0]).toMatchObject({ by: "sam_rivera", connects: ["sheets", "telegram"], budget: usdc(5).toString(), decimals: 6, offers: 0, mine: false, votedByMe: false });
    expect(board[1]!.votedByMe).toBe(true);
    expect((await requestBoard(rt, { sort: "newest" }))[0]!.need).toBe("Remind customers about unpaid invoices");
    // Taking it back, and never on your own.
    await meToo(rt, again.id, quiet.id, false);
    expect((await requestBoard(rt)).find((r) => r.id === quiet.id)!.meToo).toBe(0);
    await expect(meToo(rt, asker.id, quiet.id, true)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an empty need, a long one, and too many open requests", async () => {
    await expect(ask("   ")).rejects.toBeInstanceOf(RequestRefused);
    await expect(ask("x".repeat(141))).rejects.toThrow(/140 characters/);
    const busy = await addUser(db, "req.busy");
    for (let i = 0; i < OPEN_REQUESTS_MAX; i++) await postRequest(rt, busy.id, { need: `Need ${i}`, detail: "", connects: [], budget: null });
    await expect(postRequest(rt, busy.id, { need: "One more", detail: "", connects: [], budget: null })).rejects.toMatchObject({ status: 429 });
  });
});

describe("offers", () => {
  it("are a maker's own published agent with a note and a price; accepting one rents it at that price", async () => {
    const r = await ask("Summarise my sales sheet every morning");
    const p = await publishedAgent(db, maker);
    // Unlisted is fine: an offer is its own price.
    const offer = await makeOffer(rt, maker.id, r.id, { agentId: p.agent.id, note: "Reads any tab; I can add a weekly total.", weeklyPrice: usdc(3), jobFee: 0n });
    let page = (await requestPage(rt, r.id, asker.id))!;
    expect(page.request).toMatchObject({ mine: true, offers: 1 });
    expect(page.offers).toEqual([
      expect.objectContaining({ id: offer.id, maker: "lena_k", note: "Reads any tab; I can add a weekly total.", weeklyPrice: usdc(3).toString(), status: "open", mine: false, agent: expect.objectContaining({ id: p.agent.id, version: 1, listed: false, connects: ["telegram", "sheets"] }) }),
    ]);
    // Offering again changes it.
    await makeOffer(rt, maker.id, r.id, { agentId: p.agent.id, note: "Now with a weekly total.", weeklyPrice: usdc(2.5), jobFee: 0n });
    page = (await requestPage(rt, r.id, maker.id))!;
    expect(page.offers).toHaveLength(1);
    expect(page.offers[0]).toMatchObject({ note: "Now with a weekly total.", weeklyPrice: usdc(2.5).toString(), mine: true });

    // Only the one who asked accepts.
    await expect(acceptOffer(rt, maker.id, offer.id)).rejects.toMatchObject({ status: 404 });
    const rental = await acceptOffer(rt, asker.id, offer.id);
    expect(rental).toMatchObject({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: usdc(2.5).toString(), renterUserId: asker.id, status: "active" });
    expect((await balancesOf(asker.id, db as never)).USDC.available).toBe(usdc(27.5));
    page = (await requestPage(rt, r.id))!;
    expect(page.request.status).toBe("accepted");
    expect(page.offers[0]!.status).toBe("accepted");
    expect((await db.select().from(schema.requestOffers).where(eq(schema.requestOffers.id, offer.id)))[0]!.rentalId).toBe(rental.id);
    // Answered: off the board, no more offers or me too.
    expect((await requestBoard(rt)).map((x) => x.id)).not.toContain(r.id);
    await expect(makeOffer(rt, maker.id, r.id, { agentId: p.agent.id, note: "", weeklyPrice: 0n, jobFee: 0n })).rejects.toMatchObject({ status: 409 });
    expect((await requestsOf(rt, asker.id)).find((x) => x.id === r.id)!.status).toBe("accepted");
  });

  it("refuses someone else's agent, an unpublished one and one's own request; withdrawn offers leave the page", async () => {
    const r = await ask("Watch a supplier page for price drops");
    const other = await addUser(db, "req.other");
    const theirs = await publishedAgent(db, other);
    await expect(makeOffer(rt, maker.id, r.id, { agentId: theirs.agent.id, note: "", weeklyPrice: 0n, jobFee: 0n })).rejects.toMatchObject({ status: 404 });
    const [draft] = await db.insert(schema.agents).values({ ownerUserId: maker.id, name: "Unpublished" }).returning();
    await expect(makeOffer(rt, maker.id, r.id, { agentId: draft!.id, note: "", weeklyPrice: 0n, jobFee: 0n })).rejects.toMatchObject({ status: 409 });
    const mine = await publishedAgent(db, asker);
    await expect(makeOffer(rt, asker.id, r.id, { agentId: mine.agent.id, note: "", weeklyPrice: 0n, jobFee: 0n })).rejects.toMatchObject({ status: 409 });
    const p = await publishedAgent(db, maker);
    const offer = await makeOffer(rt, maker.id, r.id, { agentId: p.agent.id, note: "", weeklyPrice: 0n, jobFee: 0n });
    await expect(withdrawOffer(rt, asker.id, offer.id)).rejects.toMatchObject({ status: 404 });
    await withdrawOffer(rt, maker.id, offer.id);
    expect((await requestPage(rt, r.id))!.offers).toEqual([]);
    await expect(acceptOffer(rt, asker.id, offer.id)).rejects.toMatchObject({ status: 409 });
    // Closing: only the one who asked.
    await expect(closeRequest(rt, maker.id, r.id)).rejects.toMatchObject({ status: 404 });
    await closeRequest(rt, asker.id, r.id);
    expect((await requestPage(rt, r.id))!.request.status).toBe("closed");
    await expect(meToo(rt, maker.id, r.id, true)).rejects.toMatchObject({ status: 409 });
  });

  it("can't be accepted when the balance doesn't cover the first week", async () => {
    const broke = await addUser(db, "req.broke");
    const r = await postRequest(rt, broke.id, { need: "Post my sheet to a channel", detail: "", connects: [], budget: null });
    const p = await publishedAgent(db, maker);
    const offer = await makeOffer(rt, maker.id, r.id, { agentId: p.agent.id, note: "", weeklyPrice: usdc(4), jobFee: 0n });
    await expect(acceptOffer(rt, broke.id, offer.id)).rejects.toMatchObject({ status: 402 });
    expect((await requestPage(rt, r.id))!.request.status).toBe("open");
  });
});
