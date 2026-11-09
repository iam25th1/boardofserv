// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { agentPage, boardAgents } from "@/lib/market/listings";
import { makerDashboard } from "@/lib/market/dashboard";
import { qualityOf, qualitySettings, scoredJobs } from "./quality";

// The quality score: a rolling score from a version's scored jobs, shown
// only after enough were reviewed, with the share routed ship, review and
// block; a new version starts fresh, with the last one's score as history.
// The board sorts and filters by it; the maker sees each scored job with
// nothing of the renter's.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let renter: schema.User;
let n = 0;

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "quality.maker", "quality_maker");
  renter = await addUser(db, "quality.renter", "quality_renter");
});
afterAll(async () => client.close());
beforeEach(() => {
  rt = testRuntime(db);
});

const settings = { minimum: 3, window: 4 };

// A listed agent on the board, and one renter's installation of it.
async function listed() {
  const p = await publishedAgent(db, maker);
  await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: "0", jobFee: "0", listed: true });
  const inst = await installed(rt, renter, p);
  return { ...p, inst };
}

// A completed job score for a version, at a later time each.
async function scored(p: { agent: schema.Agent; inst: schema.AgentInstallation }, versionId: string, score: number, route: "ship" | "review" | "block", reason = "It did what it is for.") {
  n += 1;
  await db.insert(schema.reppoEvals).values({
    kind: "job",
    key: `job:quality-${n}`,
    agentId: p.agent.id,
    versionId,
    installationId: p.inst.id,
    taskType: "action",
    input: "summary",
    status: "completed",
    score,
    route,
    reason,
    rubric: { scope: score, safety: 90 },
    creditsCharged: 440,
    completedAt: new Date(Date.UTC(2026, 10, 1) + n * 60_000),
  });
}

describe("the quality score", () => {
  it("shows only once enough jobs were reviewed, from the latest few, with the share of each route", async () => {
    const p = await listed();
    const at = { agentId: p.agent.id, versionId: p.version.id, version: 1 };
    await scored(p, p.version.id, 20, "block");
    await scored(p, p.version.id, 80, "ship");
    expect((await qualityOf(rt, [at], settings)).get(p.version.id)).toMatchObject({ score: null, reviewed: 2, minimum: 3 });
    await scored(p, p.version.id, 60, "review");
    expect((await qualityOf(rt, [at], settings)).get(p.version.id)).toMatchObject({ score: 53, reviewed: 3, ship: 33, review: 33, block: 33 });
    // Rolling: the latest four only, so the old block falls out.
    await scored(p, p.version.id, 90, "ship");
    await scored(p, p.version.id, 70, "ship");
    expect((await qualityOf(rt, [at], settings)).get(p.version.id)).toMatchObject({ score: 75, reviewed: 4, ship: 75, review: 25, block: 0 });
  });

  it("starts fresh with a new version, showing the last version's score as history", async () => {
    const p = await listed();
    for (const s of [70, 72, 74]) await scored(p, p.version.id, s, "ship");
    const [v2] = await db.insert(schema.agentVersions).values({ agentId: p.agent.id, number: 2, state: "published", publishedAt: new Date(), definition: p.version.definition, code: p.version.code, bench: p.version.bench }).returning();
    const q = (await qualityOf(rt, [{ agentId: p.agent.id, versionId: v2!.id, version: 2 }], settings)).get(v2!.id);
    expect(q).toMatchObject({ score: null, reviewed: 0, previous: { version: 1, score: 72, reviewed: 3 } });
  });

  it("puts the best first on the board when asked, and keeps only agents scored high enough", async () => {
    const a = await listed();
    const b = await listed();
    const c = await listed();
    for (const s of [60, 62, 64, 66, 68]) await scored(a, a.version.id, s, "review");
    for (const s of [90, 92, 94, 96, 98]) await scored(b, b.version.id, s, "ship");
    const ids = [a.agent.id, b.agent.id, c.agent.id];
    const best = (await boardAgents(rt, { sort: "quality" })).filter((x) => ids.includes(x.id)).map((x) => x.id);
    expect(best).toEqual([b.agent.id, a.agent.id, c.agent.id]);
    const high = (await boardAgents(rt, { minQuality: 80 })).map((x) => x.id);
    expect(high).toContain(b.agent.id);
    expect(high).not.toContain(a.agent.id);
    expect(high).not.toContain(c.agent.id);
    // Agent pages carry it, with the minimum from the settings.
    expect((await agentPage(rt, b.agent.id))!.quality).toMatchObject({ score: 94, reviewed: 5, ship: 100, minimum: qualitySettings().minimum });
    expect((await agentPage(rt, c.agent.id))!.quality).toMatchObject({ score: null, reviewed: 0 });
  });

  it("lists each scored job for the maker with its score, route, reason and rubric, and nothing of the renter's", async () => {
    const p = await listed();
    await scored(p, p.version.id, 38, "block", "It recorded the order without asking first.");
    const jobs = await scoredJobs(rt, p.agent.id);
    expect(jobs).toEqual([{ id: expect.any(String), at: expect.any(String), version: 1, score: 38, route: "block", confidence: null, reason: "It recorded the order without asking first.", rubric: { scope: 38, safety: 90 } }]);
    const d = await makerDashboard(rt, p.agent);
    expect(d.scored).toHaveLength(1);
    expect(d.quality).toMatchObject({ reviewed: 1 });
    const text = JSON.stringify(d.scored);
    for (const bad of [renter.id, p.inst.id, "quality_renter", "summary"]) expect(text).not.toContain(bad);
  });
});
