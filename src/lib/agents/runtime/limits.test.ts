// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { AgentDefinition } from "@/lib/agents/definition";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, RESTOCK_CODE, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { claimJob, enqueue, runJob } from "./jobs";
import { jobFor, jobsOfAgent, spendToday } from "./views";

// Step logs with costs, who sees what of them, and the limits that fail a
// job with a plain reason.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let owner: schema.User;
let stranger: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "maker");
  owner = await addUser(db, "owner");
  stranger = await addUser(db, "stranger");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"]));
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
});

async function run(inst: schema.AgentInstallation) {
  const job = await enqueue(rt, inst, { kind: "manual" });
  rt.clock.move(1000);
  await runJob(rt, (await claimJob(rt, "w"))!, "w");
  return (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id)))[0]!;
}

describe("a job's log", () => {
  it("shows its owner everything, the maker how it ran without the owner's data, anyone else nothing", async () => {
    const p = await publishedAgent(db, maker);
    const inst = await installed(rt, owner, p, { settings: { stock_sheet: "Stock", orders_sheet: "Orders" } });
    const job = await run(inst);
    const mine = (await jobFor(rt, owner.id, job.id))!;
    expect(mine).toMatchObject({ viewer: "owner", status: "done", agentName: "Fabric restock", started: "by hand", stepCount: 4, reason: "It reached the end of its steps." });
    expect(mine.costUsd).toBeGreaterThan(0);
    const decision = mine.steps.find((s) => s.stepId === "check_total")!;
    expect(decision).toMatchObject({ kind: "decision", status: "ok", outcome: "within", model: expect.any(String) });
    expect(decision.costUsd).toBeCloseTo((400 * 1.25 + 20 * 6.5) / 1e6, 10);
    expect(mine.steps[0]!.input).toEqual({ settings: { stock_sheet: "Stock", orders_sheet: "Orders" } });
    expect(mine.steps[0]!.calls?.[0]).toMatchObject({ tool: "sheets.read", args: { sheet: "Stock" } });

    const makers = (await jobFor(rt, maker.id, job.id))!;
    expect(makers.viewer).toBe("maker");
    expect(makers.reason).toBeNull();
    expect(makers.steps[0]).toEqual({ seq: 1, stepId: "find_low", title: "Find low stock", kind: "code", status: "ok", ms: expect.any(Number), model: null, costUsd: 0, tools: [{ tool: "sheets.read", failed: false }] });
    const text = JSON.stringify(makers);
    for (const secret of ["Linen, natural", "Stock", "Orders", "total_usdc", "within"]) expect(text, secret).not.toContain(secret);

    expect(await jobFor(rt, stranger.id, job.id)).toBeNull();
    const list = await jobsOfAgent(rt, maker.id, p.agent.id);
    expect(list[0]).toMatchObject({ id: job.id, mine: false, reason: null });
  });
});

describe("limits", () => {
  it("fails a job that reaches its steps, time or spend limit, saying which", async () => {
    const d = restockDefinition();
    const few: AgentDefinition = { ...d, limits: { ...d.limits, maxSteps: 2 } };
    expect((await run(await installed(rt, owner, await publishedAgent(db, maker, { definition: few }))))).toMatchObject({ status: "failed", reason: "It reached its limit of 2 steps." });
    const cheap: AgentDefinition = { ...d, limits: { ...d.limits, maxSpendUsd: 0 } };
    expect(await run(await installed(rt, owner, await publishedAgent(db, maker, { definition: cheap })))).toMatchObject({ status: "failed", reason: "It reached its spend limit of $0." });
    const slow = { ...RESTOCK_CODE, find_low: { ...RESTOCK_CODE.find_low, source: "async function run() { while (true) {} }" } };
    const quick: AgentDefinition = { ...d, limits: { ...d.limits, maxRunSeconds: 5 } };
    const timed = await run(await installed(rt, owner, await publishedAgent(db, maker, { definition: quick, code: slow })));
    expect(timed).toMatchObject({ status: "failed" });
    expect(timed.reason).toMatch(/ran out of time/);
  }, 20_000);

  it("stops at the installation's daily spend cap, and a new day starts afresh", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, maker), { dailySpendUsd: 0.0006 });
    expect((await run(inst)).status).toBe("done");
    expect(await spendToday(rt, inst.id)).toBeCloseTo((400 * 1.25 + 20 * 6.5) / 1e6, 10);
    expect(await run(inst)).toMatchObject({ status: "failed", reason: "It reached its daily spend limit of $0.0006 for today." });
    rt.clock.move(86_400_000);
    expect((await run(inst)).status).toBe("done");
  });

  it("counts towards the site's daily limit, and stops when the site has reached it", async () => {
    const recorded: unknown[] = [];
    rt.record = async (_owner, call) => void recorded.push(call);
    const inst = await installed(rt, owner, await publishedAgent(db, maker));
    await run(inst);
    expect(recorded).toHaveLength(1);
    rt.siteRefusal = async () => "boardofserv has hit today's limit. It resets at midnight UTC.";
    expect(await run(inst)).toMatchObject({ status: "failed", reason: "boardofserv has hit today's limit. It resets at midnight UTC." });
  });
});
