// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { fakeReppo } from "@/test/fakeReppo";
import { boardAgents } from "@/lib/market/listings";
import { makerDashboard } from "@/lib/market/dashboard";
import { control, loadInstallation } from "@/lib/agents/runtime/installations";
import { moderate, moderationQueue } from "@/lib/safety/moderation";
import { holdReason, onJobResult, renterNote } from "./blocks";
import { reppoCycle } from "./cycle";

// A job Reppo routes to block is flagged to its maker and waits in the
// admin queue. Several on one version within a window put its listing on
// hold for review: off the board, renters told in plain words, their
// installations running as before with their pause button.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let renter: schema.User;
let admin: schema.User;
let n = 0;

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "blocks.maker", "blocks_maker");
  renter = await addUser(db, "blocks.renter", "blocks_renter");
  admin = await addUser(db, "blocks.admin", "blocks_admin");
});
afterAll(async () => client.close());
beforeEach(() => {
  rt = testRuntime(db);
});

const hold = { blocks: 2, days: 7 };

async function listed() {
  const p = await publishedAgent(db, maker);
  await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: "0", jobFee: "0", listed: true });
  const inst = await installed(rt, renter, p);
  return { ...p, inst };
}

// A job score coming back, at the runtime's clock.
async function result(p: { agent: schema.Agent; inst: schema.AgentInstallation }, versionId: string, route: "ship" | "review" | "block") {
  n += 1;
  const [row] = await db
    .insert(schema.reppoEvals)
    .values({ kind: "job", key: `job:blocks-${n}`, agentId: p.agent.id, versionId, installationId: p.inst.id, taskType: "action", input: "summary", status: "completed", score: route === "block" ? 30 : 85, route, reason: route === "block" ? "It wrote orders the person never asked for." : "Fine.", creditsCharged: 440, completedAt: rt.now() })
    .returning();
  return onJobResult(rt, row!, hold);
}

const listingOf = async (agentId: string) => (await db.select().from(schema.agentListings).where(eq(schema.agentListings.agentId, agentId)))[0]!;
const onBoard = async (agentId: string) => (await boardAgents(rt)).some((a) => a.id === agentId);

describe("Reppo's blocks", () => {
  it("are flagged to the maker and wait in the admin queue with Reppo's reason", async () => {
    const p = await listed();
    expect(await result(p, p.version.id, "block")).toBe(false);
    const q = await moderationQueue(rt);
    const mine = q.blocked.filter((b) => b.agentId === p.agent.id && b.maker === "@blocks_maker");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]).toMatchObject({ version: 1, score: 30, reason: "It wrote orders the person never asked for." });
    const d = await makerDashboard(rt, p.agent);
    expect(d.flagged).toBe(1);
    expect(d.scored[0]).toMatchObject({ route: "block", flagged: true });
    // One block alone doesn't hold the listing.
    expect(await onBoard(p.agent.id)).toBe(true);
  });

  it("put the listing on hold when they repeat within the window, and tell its renters", async () => {
    const p = await listed();
    await result(p, p.version.id, "block");
    await result(p, p.version.id, "ship");
    expect(await result(p, p.version.id, "block")).toBe(true);
    expect(await listingOf(p.agent.id)).toMatchObject({ screen: "held", screenReason: holdReason(2) });
    expect(await onBoard(p.agent.id)).toBe(false);
    expect((await moderationQueue(rt)).held.some((h) => h.type === "listing" && h.id === p.agent.id)).toBe(true);
    const told = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, p.inst.id));
    expect(told.map((m) => m.text)).toContain(renterNote(p.agent.name));
    // Their installation runs as before, and they can still pause it.
    const inst = (await loadInstallation(rt, p.inst.id))!;
    expect(inst.installation.status).toBe("active");
    await control(rt, inst, "pause");
    expect((await loadInstallation(rt, p.inst.id))!.installation.status).toBe("paused");
  });

  it("don't count outside the window, on another version, or on a listing already off the board", async () => {
    const p = await listed();
    await result(p, p.version.id, "block");
    rt.clock.move(8 * 86_400_000);
    expect(await result(p, p.version.id, "block")).toBe(false);
    const [v2] = await db.insert(schema.agentVersions).values({ agentId: p.agent.id, number: 2, state: "published", publishedAt: rt.now(), definition: p.version.definition, code: p.version.code, bench: p.version.bench }).returning();
    // Blocks on a version the board doesn't show don't hold the listing.
    await result(p, v2!.id, "block");
    expect(await result(p, v2!.id, "block")).toBe(false);
    await db.update(schema.agentListings).set({ screen: "hidden" }).where(eq(schema.agentListings.agentId, p.agent.id));
    expect(await result(p, p.version.id, "block")).toBe(false);
    expect((await listingOf(p.agent.id)).screen).toBe("hidden");
  });

  it("start counting again after an admin lets the listing back", async () => {
    const p = await listed();
    await result(p, p.version.id, "block");
    await result(p, p.version.id, "block");
    expect((await listingOf(p.agent.id)).screen).toBe("held");
    rt.clock.move(60_000);
    expect(await moderate(rt, admin, { type: "listing", id: p.agent.id }, "approve", "Looked at the jobs: the sheet was set up wrongly.")).toBe(true);
    expect(await onBoard(p.agent.id)).toBe(true);
    rt.clock.move(60_000);
    // The earlier blocks no longer count: one more doesn't hold it again.
    expect(await result(p, p.version.id, "block")).toBe(false);
    expect(await result(p, p.version.id, "block")).toBe(true);
  });

  it("are worked by an admin: approve clears the flag, hide takes the listing down, freeze stops the version", async () => {
    const p = await listed();
    await result(p, p.version.id, "block");
    const [first] = (await moderationQueue(rt)).blocked.filter((b) => b.agentId === p.agent.id);
    expect(await moderate(rt, admin, { type: "reppo", id: first!.id }, "approve", "A one-off: the supplier page was down.")).toBe(true);
    expect((await makerDashboard(rt, p.agent)).flagged).toBe(0);
    expect(await moderate(rt, admin, { type: "reppo", id: first!.id }, "approve", "Again.")).toBe(false);
    await result(p, p.version.id, "ship");
    rt.clock.move(8 * 86_400_000);
    await result(p, p.version.id, "block");
    const [second] = (await moderationQueue(rt)).blocked.filter((b) => b.agentId === p.agent.id);
    expect(await moderate(rt, admin, { type: "reppo", id: second!.id }, "freeze", "It keeps writing orders nobody asked for.")).toBe(true);
    const [f] = await db.select().from(schema.freezes).where(eq(schema.freezes.targetId, p.version.id));
    expect(f).toMatchObject({ kind: "version", reason: "It keeps writing orders nobody asked for." });
    rt.clock.move(60_000);
    await result(p, p.version.id, "block");
    const [third] = (await moderationQueue(rt)).blocked.filter((b) => b.agentId === p.agent.id);
    expect(await moderate(rt, admin, { type: "reppo", id: third!.id }, "hide", "Off the board.")).toBe(true);
    expect((await listingOf(p.agent.id)).screen).toBe("hidden");
    // A score that wasn't a block is never in the queue.
    const [ok] = await db.select().from(schema.reppoEvals).where(eq(schema.reppoEvals.route, "ship")).limit(1);
    expect(await moderate(rt, admin, { type: "reppo", id: ok!.id }, "approve", "x")).toBe(false);
  });

  it("are acted on as results come back in the cycle", async () => {
    const p = await listed();
    const reppo = fakeReppo(rt.net);
    reppo.readsToFinish = 1;
    reppo.verdict = () => ({ score: 25, route: "block", reason: "It acted outside its purpose." });
    process.env.REPPO_HOLD_BLOCKS = "1";
    // Earlier tests' scores today count against the day's credits.
    process.env.REPPO_DAILY_CREDITS = "1000000";
    try {
      await db.insert(schema.reppoEvals).values({ kind: "job", key: `job:blocks-cycle-${++n}`, agentId: p.agent.id, versionId: p.version.id, installationId: p.inst.id, taskType: "action", input: "summary", nextAt: rt.now() });
      await reppoCycle(rt);
      rt.clock.move(31_000);
      await reppoCycle(rt);
    } finally {
      delete process.env.REPPO_HOLD_BLOCKS;
      delete process.env.REPPO_DAILY_CREDITS;
    }
    expect((await listingOf(p.agent.id)).screen).toBe("held");
  });
});
