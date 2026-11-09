// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, RESTOCK_CODE, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { checkDefinition } from "../definition";
import { Halted } from "../runner";
import { claimJob, enqueue, runJob } from "./jobs";
import { control, ControlRefused, loadInstallation } from "./installations";
import { sendToAgent, MessageRefused } from "./messages";
import { fireDue } from "./triggers";
import { JobTools } from "./tools";
import { ACTIONS_REASON, JOBS_REASON, OUTBOUND_REASON, SAME_FAILURE_REASON } from "./rates";

// Limits on each installation: jobs an hour, messages an hour, actions in
// a job, a step a job keeps going round, and the same failure again and
// again. Each pauses (or stops) with a plain reason, never silently.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "rates.owner");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(eq(schema.agentJobs.status, "queued"));
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
});
afterEach(() => vi.unstubAllEnvs());

const instOf = async (id: string) => (await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, id)))[0]!;

describe("jobs an hour", () => {
  it("pauses an installation whose schedule would start more, and refuses one more by hand", async () => {
    vi.stubEnv("AGENT_JOBS_PER_HOUR", "2");
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    for (let k = 0; k < 2; k++) await enqueue(rt, inst, { kind: "manual" });
    await expect(control(rt, (await loadInstallation(rt, inst.id))!, "run")).rejects.toThrow(new ControlRefused("It has started its limit of 2 jobs this hour. Try again later."));
    await db.update(schema.agentJobs).set({ status: "done" }).where(eq(schema.agentJobs.installationId, inst.id));
    rt.clock.move(24 * 3_600_000);
    // A day later the hour is fresh again: two more, then the schedule finds no room.
    for (let k = 0; k < 2; k++) await enqueue(rt, inst, { kind: "manual" });
    await db.update(schema.agentJobs).set({ status: "done" }).where(eq(schema.agentJobs.installationId, inst.id));
    await fireDue(rt);
    expect(await instOf(inst.id)).toMatchObject({ status: "paused", pausedReason: JOBS_REASON(2) });
  });
});

describe("messages an hour and actions a job", () => {
  const d = restockDefinition();
  const def = { ...d, actions: [...d.actions, { id: "tell", tool: "telegram.send" as const, description: "Tell the owner" }] };
  const tell = { id: "tell", kind: "action" as const, title: "Tell the owner", inputs: [], outputs: [], action: "tell", next: null };

  it("pause the installation and stop the job when it would send more", async () => {
    vi.stubEnv("AGENT_OUTBOUND_PER_HOUR", "1");
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const tools = new JobTools(rt, inst, def, null);
    await tools.call(tell, "telegram.send", { text: "One." });
    await expect(tools.call(tell, "telegram.send", { text: "Two." })).rejects.toThrow(new Halted(OUTBOUND_REASON(1)));
    expect(await instOf(inst.id)).toMatchObject({ status: "paused", pausedReason: OUTBOUND_REASON(1) });
  });

  it("pause the installation when one job takes too many actions", async () => {
    vi.stubEnv("AGENT_ACTIONS_PER_JOB", "1");
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const job = await enqueue(rt, inst, { kind: "manual" });
    const tools = new JobTools(rt, inst, def, job);
    await tools.call(tell, "telegram.send", { text: "One." });
    await expect(tools.call(tell, "telegram.send", { text: "Two." })).rejects.toThrow(new Halted(ACTIONS_REASON(1)));
    expect(await instOf(inst.id)).toMatchObject({ status: "paused", pausedReason: ACTIONS_REASON(1) });
    expect((await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id)))[0]!.actions).toBe(2);
  });
});

describe("loops and repeated failures", () => {
  it("stop a job that keeps going round the same step", async () => {
    vi.stubEnv("AGENT_STEP_VISITS", "3");
    const c = checkDefinition({
      format: 1,
      name: "Round and round",
      job: { does: "Checks stock again and again.", done: "Never." },
      triggers: [{ kind: "schedule", every: "day", at: "08:00", description: "Every morning" }],
      settings: [],
      rules: [],
      memory: [],
      steps: [
        { id: "count", kind: "code", title: "Count stock", description: "Return n as 1.", inputs: [], outputs: ["n"], tools: [], next: "again" },
        { id: "again", kind: "decision", title: "Again?", prompt: "Again?", inputs: ["n"], outputs: [], outcomes: [{ id: "yes", label: "Yes", next: "count" }, { id: "no", label: "No", next: null }] },
      ],
      actions: [],
      limits: { maxSteps: 50, maxRunSeconds: 60, maxSpendUsd: 0.5 },
    });
    if (!c.ok) throw new Error(c.errors.join("; "));
    rt.serve = () => "yes";
    const code = { count: { spec: "", status: "approved" as const, source: "async function run() { return { n: 1 }; }", rounds: 1, note: null, updatedAt: "" } };
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: c.definition, code }));
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    const [j] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
    expect(j).toMatchObject({ status: "failed", reason: 'It went round to "Count stock" 3 times in one job, so it stopped there.' });
  });

  it("pause an installation whose last jobs all failed the same way", async () => {
    const broken = { ...RESTOCK_CODE, find_low: { ...RESTOCK_CODE.find_low, source: "async function run() { throw new Error('The Stock tab is empty.'); }" } };
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { code: broken }));
    for (let k = 0; k < 3; k++) {
      await enqueue(rt, inst, { kind: "manual" });
      await runJob(rt, (await claimJob(rt, "w"))!, "w");
      rt.clock.move(60_000);
    }
    const i = await instOf(inst.id);
    expect(i.status).toBe("paused");
    expect(i.pausedReason).toBe(SAME_FAILURE_REASON(3, '"Find low stock" failed: Error: The Stock tab is empty.'));
  });
});

describe("messages to an agent", () => {
  it("are refused, and the installation paused, past its jobs an hour", async () => {
    vi.stubEnv("AGENT_JOBS_PER_HOUR", "1");
    const c = checkDefinition({ ...restockDefinition(), triggers: [{ kind: "message", from: "telegram", description: "When you message it" }] });
    if (!c.ok) throw new Error(c.errors.join("; "));
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: c.definition }));
    await sendToAgent(rt, inst, c.definition, "Check now");
    await expect(sendToAgent(rt, inst, c.definition, "And again")).rejects.toBeInstanceOf(MessageRefused);
    expect((await instOf(inst.id)).pausedReason).toBe(JOBS_REASON(1));
  });
});
