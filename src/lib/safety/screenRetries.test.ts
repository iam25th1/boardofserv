// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { setListing } from "@/lib/market/listings";
import { makeOffer, postRequest } from "@/lib/market/requests";
import { jobWorker } from "@/lib/agents/runtime/worker";
import { moderate, moderationQueue, SCREEN_AGAIN, SCREEN_DOWN, screenListing, screenOffer, screenRequest } from "./moderation";
import { retryScreens, SCREEN_RETRY_DELAYS_MS } from "./screenRetries";

// A listing, request or offer that screening got no answer for (SERV
// empty or unreachable on every try of the call) is screened again by the
// worker, 2, 10 and 30 minutes later, before a person is asked to look.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let poster: schema.User;
let admin: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "again.maker", "again_maker");
  poster = await addUser(db, "again.poster", "again_poster");
  admin = await addUser(db, "again.admin", "again_admin");
});
afterAll(async () => client.close());
beforeEach(() => {
  rt = testRuntime(db);
});

const down = () => "down" as const;
const fine = () => ({ verdict: "ok" as const, reason: "An ordinary small business job." });
const retryOf = async (subject: "listing" | "request" | "offer", id: string) =>
  (await db.select().from(schema.screenRetries).where(and(eq(schema.screenRetries.subject, subject), eq(schema.screenRetries.subjectId, id))))[0] ?? null;
const inQueue = async (id: string) => (await moderationQueue(rt)).held.some((h) => h.id === id);

async function listed() {
  const p = await publishedAgent(db, maker);
  await setListing(rt, p.agent, { weeklyPrice: 0n, jobFee: 0n, listed: true });
  return p;
}

describe("screening again", () => {
  it("holds a listing SERV gave no answer for, screens it again by itself, and puts it on the board when SERV answers", async () => {
    rt.postVerdict = down;
    const p = await listed();
    expect(await screenListing(rt, maker, p.agent.id)).toBe("held");
    const [l] = await db.select().from(schema.agentListings).where(eq(schema.agentListings.agentId, p.agent.id));
    expect(l).toMatchObject({ screen: "held", screenReason: SCREEN_AGAIN });
    expect(await retryOf("listing", p.agent.id)).toMatchObject({ tries: 0, nextAt: new Date(rt.now().getTime() + SCREEN_RETRY_DELAYS_MS[0]!) });
    // Not a person's yet.
    expect(await inQueue(p.agent.id)).toBe(false);
    // Not due yet: nothing happens.
    expect(await retryScreens(rt)).toBe(0);
    rt.clock.move(SCREEN_RETRY_DELAYS_MS[0]!);
    rt.postVerdict = fine;
    expect(await retryScreens(rt)).toBe(1);
    const [after] = await db.select().from(schema.agentListings).where(eq(schema.agentListings.agentId, p.agent.id));
    expect(after).toMatchObject({ screen: "ok", screenReason: null });
    expect(await retryOf("listing", p.agent.id)).toBeNull();
  });

  it("tries three more times, 2, 10 and 30 minutes apart, then waits for a person", async () => {
    rt.postVerdict = down;
    const need = "Reorder fabric when it runs low";
    const r = await postRequest(rt, poster.id, { need, detail: "From my stock tab", connects: ["sheets"], budget: null });
    expect(await screenRequest(rt, poster, r.id, need, "From my stock tab")).toBe("held");
    const asked = () => rt.posts.length;
    let before = asked();
    for (const [i, delay] of SCREEN_RETRY_DELAYS_MS.entries()) {
      expect(await inQueue(r.id), `before try ${i + 1}`).toBe(false);
      rt.clock.move(delay - 1);
      expect(await retryScreens(rt), `a minute early, try ${i + 1}`).toBe(0);
      rt.clock.move(1);
      expect(await retryScreens(rt), `try ${i + 1}`).toBe(1);
      // Each screen is one call, tried three times inside the client.
      expect(asked() - before).toBe(3);
      before = asked();
    }
    const [q] = await db.select().from(schema.requests).where(eq(schema.requests.id, r.id));
    expect(q).toMatchObject({ screen: "held", screenReason: SCREEN_DOWN });
    expect(await retryOf("request", r.id)).toMatchObject({ tries: 3, nextAt: null });
    expect(await inQueue(r.id)).toBe(true);
    rt.clock.move(24 * 3_600_000);
    expect(await retryScreens(rt)).toBe(0);
  });

  it("never screens again what SERV answered: a hold, or an answer it couldn't use", async () => {
    rt.postVerdict = () => ({ verdict: "hold" as const, reason: "It asks for a stranger's home address." });
    const need = "Find where my neighbour lives";
    const held = await postRequest(rt, poster.id, { need, detail: "", connects: [], budget: null });
    expect(await screenRequest(rt, poster, held.id, need, "")).toBe("held");
    expect(await retryOf("request", held.id)).toBeNull();
    expect(await inQueue(held.id)).toBe(true);

    rt.fetchImpl = (async () => Response.json({ choices: [{ message: { content: "I can't help with that." } }] })) as typeof fetch;
    const words = await postRequest(rt, poster.id, { need: "Something else", detail: "", connects: [], budget: null });
    expect(await screenRequest(rt, poster, words.id, "Something else", "")).toBe("held");
    expect(await retryOf("request", words.id)).toBeNull();
    const [q] = await db.select().from(schema.requests).where(eq(schema.requests.id, words.id));
    expect(q!.screenReason).toBe("It needs a person to look.");
  });

  it("stops when an admin decides, and runs from the worker's cycle", async () => {
    rt.postVerdict = fine;
    const p = await listed();
    await screenListing(rt, maker, p.agent.id);
    const need = "Count my stock every morning";
    const r = await postRequest(rt, poster.id, { need, detail: "", connects: ["sheets"], budget: null });
    await screenRequest(rt, poster, r.id, need, "");
    const offer = await makeOffer(rt, maker.id, r.id, { agentId: p.agent.id, note: "Mine counts stock.", weeklyPrice: 0n, jobFee: 0n });
    rt.postVerdict = down;
    expect(await screenOffer(rt, maker, offer.id, offer.note, { name: p.agent.name, does: "Counts stock" })).toBe("held");
    expect(await retryOf("offer", offer.id)).toMatchObject({ tries: 0 });
    // The worker screens it again when it is due.
    rt.clock.move(SCREEN_RETRY_DELAYS_MS[0]!);
    rt.postVerdict = fine;
    const worker = jobWorker(rt);
    await worker.cycle();
    await Promise.all(worker.running());
    worker.stop();
    const [o] = await db.select().from(schema.requestOffers).where(eq(schema.requestOffers.id, offer.id));
    expect(o!.screen).toBe("ok");
    expect(await retryOf("offer", offer.id)).toBeNull();

    // Held again for want of an answer, then an admin approves: no more tries.
    rt.postVerdict = down;
    const r2 = await postRequest(rt, poster.id, { need: "Tidy my orders tab", detail: "", connects: ["sheets"], budget: null });
    await screenRequest(rt, poster, r2.id, "Tidy my orders tab", "");
    expect(await retryOf("request", r2.id)).not.toBeNull();
    expect(await moderate(rt, admin, { type: "request", id: r2.id }, "approve", "Fine.")).toBe(true);
    expect(await retryOf("request", r2.id)).toBeNull();
  });
});
