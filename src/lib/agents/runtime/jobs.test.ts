// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { asc, eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import type { AgentDefinition, CodeStepDef } from "@/lib/agents/definition";
import { installed, publishedAgent, RESTOCK_CODE, restockDefinition, sheetRows, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { BACKOFF_MS, claimJob, enqueue, MAX_ATTEMPTS, requeueStale, runJob, STALE_MS } from "./jobs";
import { jobWorker } from "./worker";

// Jobs on the real migrations: claimed once, run on their version, logged
// step by step, retried after failures outside the agent and not after the
// agent's own, and picked up after a restart without doing anything twice.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "maker");
});
afterAll(async () => client.close());
beforeEach(async () => {
  // Each test claims only its own jobs.
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"]));
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
});

const jobOf = async (id: string) => (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, id)))[0]!;
const stepsOf = async (id: string) => db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, id)).orderBy(asc(schema.agentJobSteps.seq));

describe("a job", () => {
  it("is claimed once, runs its steps and ends done, with every step logged", async () => {
    const inst = await installed(rt, maker, await publishedAgent(db, maker));
    const job = await enqueue(rt, inst, { kind: "manual" });
    const a = await claimJob(rt, "worker-a");
    const b = await claimJob(rt, "worker-b");
    expect(a?.id).toBe(job.id);
    expect(b).toBeNull();
    await runJob(rt, a!, "worker-a");
    const done = await jobOf(job.id);
    expect(done).toMatchObject({ status: "done", reason: "It reached the end of its steps.", claimedBy: null });
    const steps = await stepsOf(job.id);
    expect(steps.map((s) => `${s.stepId}:${s.status}`)).toEqual(["find_low:ok", "compare:ok", "check_total:ok", "record:ok"]);
    expect(steps[2]).toMatchObject({ outcome: "within", model: expect.any(String) });
    expect(Number(steps[2]!.costUsd)).toBeGreaterThan(0);
    expect(steps[0]!.tools).toEqual([expect.objectContaining({ tool: "sheets.read", args: { sheet: "Stock" } })]);
    // The order went to the owner's own Orders tab.
    expect(sheetRows(rt, inst, "orders_sheet")).toHaveLength(2);
  });

  it("is tried again later when SERV doesn't answer, and fails after the last try", async () => {
    const inst = await installed(rt, maker, await publishedAgent(db, maker));
    rt.serve = () => "";
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    let row = await jobOf(job.id);
    expect(row).toMatchObject({ status: "queued", attempts: 1, reason: '"Big order?" got no decision from SERV.' });
    expect(row.runAfter.getTime() - rt.now().getTime()).toBe(BACKOFF_MS[0]);
    // Not before its time.
    expect(await claimJob(rt, "w")).toBeNull();
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      rt.clock.move(BACKOFF_MS[i - 1]!);
      await runJob(rt, (await claimJob(rt, "w"))!, "w");
    }
    row = await jobOf(job.id);
    expect(row).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(row.reason).toMatch(/It was tried 3 times\.$/);
    // The steps before the decision ran once each, never again.
    expect((await stepsOf(job.id)).filter((s) => s.stepId === "find_low")).toHaveLength(1);
  });

  it("is not tried again when the agent's own code fails", async () => {
    const p = await publishedAgent(db, maker, { code: { ...RESTOCK_CODE, find_low: { spec: "", status: "approved", source: "async function run() { throw new Error('bad'); }", rounds: 1, note: null, updatedAt: "" } } });
    const job = await enqueue(rt, await installed(rt, maker, p), { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    expect(await jobOf(job.id)).toMatchObject({ status: "failed", attempts: 0, reason: '"Find low stock" failed: Error: bad' });
  });

  it("runs on the version it started on, whatever the installation moves to", async () => {
    const p = await publishedAgent(db, maker);
    const inst = await installed(rt, maker, p);
    const job = await enqueue(rt, inst, { kind: "manual" });
    const [v2] = await db
      .insert(schema.agentVersions)
      .values({ agentId: p.agent.id, number: 2, state: "published", publishedAt: new Date(), definition: { ...p.version.definition!, steps: [] } as never, code: {} })
      .returning();
    await db.update(schema.agentInstallations).set({ versionId: v2!.id }).where(eq(schema.agentInstallations.id, inst.id));
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    expect(await jobOf(job.id)).toMatchObject({ status: "done", versionId: p.version.id });
  });

  it("goes back in the queue when its worker stops beating, and picks up where it was", async () => {
    const inst = await installed(rt, maker, await publishedAgent(db, maker));
    const job = await enqueue(rt, inst, { kind: "manual" });
    const claimed = (await claimJob(rt, "dead"))!;
    // The dead worker had saved the first step as done.
    await db
      .update(schema.agentJobs)
      .set({ state: { at: "compare", bag: { settings: { stock_sheet: "Stock", orders_sheet: "Orders", suppliers_sheet: "Suppliers" }, rules: { approval_over_usdc: 250, max_delivery_days: 7 }, memory: {}, trigger: { kind: "manual" }, low: [{ fabric: "Wool felt", metres: 6, minimum: 10 }] }, steps: 1, ms: 5, costUsd: 0, journal: [], resumed: false } })
      .where(eq(schema.agentJobs.id, claimed.id));
    expect(await requeueStale(rt)).toBe(0);
    rt.clock.move(STALE_MS + 1);
    expect(await requeueStale(rt)).toBe(1);
    const again = (await claimJob(rt, "alive"))!;
    expect(again.id).toBe(job.id);
    await runJob(rt, again, "alive");
    const steps = await stepsOf(job.id);
    expect(steps.map((s) => s.stepId)).toEqual(["compare", "check_total", "record"]);
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
  });

  it("after a restart mid-step, replays the calls the step had made instead of making them again", async () => {
    const d = restockDefinition();
    const telling: AgentDefinition = {
      ...d,
      actions: [...d.actions, { id: "tell", tool: "telegram.send", description: "Tell the owner" }],
      steps: [{ ...(d.steps[0] as CodeStepDef), tools: ["telegram.send"], inputs: [], next: null }],
    };
    const TELL = `async function run(input, tools) {
  await tools.telegram.send({ text: "first" });
  await tools.telegram.send({ text: "second" });
  return { low: [] };
}`;
    const inst = await installed(rt, maker, await publishedAgent(db, maker, { definition: telling, code: { ...RESTOCK_CODE, find_low: { ...RESTOCK_CODE.find_low, source: TELL } } }));
    const job = await enqueue(rt, inst, { kind: "manual" });
    const claimed = (await claimJob(rt, "dead"))!;
    // The dead worker had sent the first message, and saved that it had.
    await db.insert(schema.agentMessages).values({ installationId: inst.id, from: "agent", text: "first", jobId: job.id });
    await db
      .update(schema.agentJobs)
      .set({ state: { at: "find_low", bag: { settings: {}, rules: {}, memory: {}, trigger: { kind: "manual" } }, steps: 1, ms: 3, costUsd: 0, journal: [{ tool: "telegram.send", args: { text: "first" }, result: { sent: true } }], resumed: true } })
      .where(eq(schema.agentJobs.id, claimed.id));
    rt.clock.move(STALE_MS + 1);
    await requeueStale(rt);
    await runJob(rt, (await claimJob(rt, "alive"))!, "alive");
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    const sent = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id));
    expect(sent.map((m) => m.text).sort()).toEqual(["first", "second"]);
    // Still one step: the restart didn't count it twice.
    expect((await jobOf(job.id)).state!.steps).toBe(1);
  });

  it("stops writing at once when another worker has taken it over", async () => {
    const inst = await installed(rt, maker, await publishedAgent(db, maker));
    const job = await enqueue(rt, inst, { kind: "manual" });
    const claimed = (await claimJob(rt, "old"))!;
    await db.update(schema.agentJobs).set({ claimedBy: "new" }).where(eq(schema.agentJobs.id, job.id));
    await runJob(rt, claimed, "old");
    expect(await jobOf(job.id)).toMatchObject({ status: "running", claimedBy: "new" });
    expect(await stepsOf(job.id)).toEqual([]);
  });

  it("waits the installation's minimum gap before starting the next job", async () => {
    const inst = await installed(rt, maker, await publishedAgent(db, maker), { minGapMinutes: 10 });
    const first = await enqueue(rt, inst, { kind: "manual" });
    const second = await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    expect(await claimJob(rt, "w")).toBeNull();
    rt.clock.move(10 * 60_000 + 1);
    expect((await claimJob(rt, "w"))?.id).toBe(second.id);
    expect((await jobOf(first.id)).status).toBe("done");
  });
});

describe("the worker", () => {
  it("claims up to its capacity each cycle and never runs a job twice", async () => {
    const p = await publishedAgent(db, maker);
    const jobs = [];
    for (let i = 0; i < 3; i++) jobs.push(await enqueue(rt, await installed(rt, maker, p), { kind: "manual" }));
    const a = jobWorker(rt, 2);
    const b = jobWorker(rt, 2);
    await Promise.all([a.cycle(), b.cycle()]);
    await Promise.all([...a.running(), ...b.running()]);
    await Promise.all([a.cycle(), b.cycle()]);
    await Promise.all([...a.running(), ...b.running()]);
    a.stop();
    b.stop();
    for (const j of jobs) {
      expect((await jobOf(j.id)).status).toBe("done");
      expect((await stepsOf(j.id)).filter((s) => s.stepId === "record")).toHaveLength(1);
    }
  });
});
