// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { LIMIT_MESSAGE } from "@/lib/limits";
import { marketActionsToday, marketRefusal } from "./limits";
import { makeOffer, meToo, postRequest } from "./requests";
import { rent } from "./rentals";

// The site's limits on the market: invite-only, a daily cap on each
// person's market actions, and the site's daily model budget.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
});
afterAll(async () => client.close());
afterEach(() => {
  vi.unstubAllEnvs();
  rt.siteRefusal = async () => null;
});

const body = async (r: Response | null) => (r ? { status: r.status, ...((await r.json()) as object) } : null);

describe("market limits", () => {
  it("turn away an account not let in yet", async () => {
    vi.stubEnv("INVITE_ONLY", "1");
    const waiting = await addUser(db, "lim.waiting", "lim_waiting", "waiting");
    expect(await body(await marketRefusal(rt, waiting, { counted: true, spends: true }))).toMatchObject({ status: 403, access: "waiting" });
    expect(await marketRefusal(rt, await addUser(db, "lim.ok"), { counted: true, spends: true })).toBeNull();
  });

  it("cap each person's market actions a day at the chat's limit, and reset at midnight UTC", async () => {
    vi.stubEnv("CHAT_DAILY_LIMIT", "4");
    const busy = await addUser(db, "lim.busy");
    const maker = await addUser(db, "lim.maker");
    const r1 = await postRequest(rt, busy.id, { need: "One", detail: "", connects: [], budget: null });
    const other = await postRequest(rt, maker.id, { need: "Two", detail: "", connects: [], budget: null });
    await meToo(rt, busy.id, other.id, true);
    const p = await publishedAgent(db, busy);
    await makeOffer(rt, busy.id, other.id, { agentId: p.agent.id, note: "", weeklyPrice: 0n, jobFee: 0n });
    const listed = await publishedAgent(db, maker);
    await db.insert(schema.agentListings).values({ agentId: listed.agent.id, versionId: listed.version.id, weeklyPrice: "0" });
    await rent(rt, { renterUserId: busy.id, agentId: listed.agent.id });
    expect(await marketActionsToday(rt, busy.id)).toBe(4);
    const refused = await body(await marketRefusal(rt, busy, { counted: true }));
    expect(refused).toMatchObject({ status: 429, limit: "market" });
    expect((refused as unknown as { error: string }).error).toMatch(/^That's 4 things on the market today, the daily limit\. It resets at midnight UTC/);
    // Not counted: setting up and resuming.
    expect(await marketRefusal(rt, busy, { spends: true })).toBeNull();
    rt.clock.move(24 * 3_600_000);
    expect(await marketActionsToday(rt, busy.id)).toBe(0);
    expect(r1.id).toBeTruthy();
  });

  it("pause what spends once the site's day budget is spent, except on one's own SERV key", async () => {
    const u = await addUser(db, "lim.site");
    rt.siteRefusal = async (_owner, ownKey) => (ownKey ? null : LIMIT_MESSAGE);
    expect(await body(await marketRefusal(rt, u, { spends: true }))).toMatchObject({ status: 429, limit: "site", error: LIMIT_MESSAGE });
    // A "me too" spends nothing.
    expect(await marketRefusal(rt, u, { counted: true })).toBeNull();
  });
});
