// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { publishedAgent } from "@/test/runtimeFixtures";
import type { AgentListingDTO } from "@/lib/types";
import { GET } from "./route";

// The board's quality order and filter through the real route: anything
// that isn't a number or an order it knows is ignored, a number over 100
// is 100, and an agent's quality carries no evaluation's input or reason.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let good: string;
let fair: string;

const agents = async (qs: string): Promise<AgentListingDTO[]> => ((await (await GET(new Request(`http://localhost/api/board?${qs}`))).json()) as { agents: AgentListingDTO[] }).agents;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  const maker = await addUser(db, "board.quality.maker", "board_quality_maker");
  const renter = await addUser(db, "board.quality.renter", "board_quality_renter");
  let n = 0;
  for (const [score, route] of [
    [92, "ship"],
    [66, "review"],
  ] as const) {
    const p = await publishedAgent(db, maker);
    await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: "0", jobFee: "0", listed: true, createdAt: new Date(Date.UTC(2026, 10, 1, n)) });
    if (score === 92) good = p.agent.id;
    else fair = p.agent.id;
    for (let i = 0; i < 5; i++) {
      await db.insert(schema.reppoEvals).values({
        kind: "job",
        key: `job:board-${++n}`,
        agentId: p.agent.id,
        versionId: p.version.id,
        installationId: renter.id,
        taskType: "action",
        input: `PRIVATE INPUT ${renter.id}`,
        status: "completed",
        score,
        route,
        reason: "PRIVATE REASON",
        creditsCharged: 440,
        completedAt: new Date(Date.UTC(2026, 10, 2, n)),
      });
    }
  }
});
afterAll(async () => client.close());

describe("the board's quality", () => {
  it("orders by quality and keeps agents scored high enough", async () => {
    expect((await agents("sort=quality")).map((a) => a.id)).toEqual([good, fair]);
    expect((await agents("quality=80")).map((a) => a.id)).toEqual([good]);
    expect((await agents("quality=60&sort=quality")).map((a) => a.id)).toEqual([good, fair]);
  });

  it("ignores what it can't read, and caps a number over 100", async () => {
    for (const qs of ["quality=abc", "quality=-5", "quality=1e3", "quality=", "sort=../../admin", "sort=quality%27--"]) {
      expect((await agents(qs)).map((a) => a.id).sort(), qs).toEqual([good, fair].sort());
    }
    expect(await agents("quality=999")).toEqual([]);
  });

  it("shows a score, never an evaluation's input or reason", async () => {
    const all = await agents("sort=quality");
    expect(all[0]!.quality).toMatchObject({ score: 92, reviewed: 5, ship: 100 });
    const text = JSON.stringify(all);
    expect(text).not.toContain("PRIVATE");
  });
});
