// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { asc, eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { AgentDefinition, CodeStepDef } from "@/lib/agents/definition";
import { addUser, testDb } from "@/test/helperDb";
import { installed, linkConnections, publishedAgent, RESTOCK_CODE, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { approvalsOf } from "./approvals";
import { control, ControlRefused, installationDTO, loadInstallation } from "./installations";
import { claimJob, enqueue, runJob } from "./jobs";
import { fireDue } from "./triggers";

// The owner's controls: pause, resume, stop, run now.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;
let server: Server;
let origin: string;
let release: () => void = () => {};

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "owner");
  await linkConnections(testRuntime(db), owner);
  // A page that answers only when the test says so.
  server = createServer((_req, res) => {
    release = () => res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await client.close();
});
beforeEach(async () => {
  await db.update(schema.agentInstallations).set({ status: "stopped" });
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"]));
  rt = testRuntime(db);
  rt.web = { allowOrigins: [origin] };
  rt.serve = (ids) => (ids.includes("over") ? "over" : ids[0]!);
});

const loaded = async (id: string) => (await loadInstallation(rt, id))!;
const jobsOf = (id: string) => db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, id)).orderBy(asc(schema.agentJobs.createdAt));

describe("pause and resume", () => {
  it("pausing stops triggers and jobs from starting; resuming picks the schedule up from now", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    await control(rt, await loaded(inst.id), "run");
    await control(rt, await loaded(inst.id), "pause");
    await expect(control(rt, await loaded(inst.id), "pause")).rejects.toThrow("It's paused already.");
    await expect(control(rt, await loaded(inst.id), "run")).rejects.toThrow("Resume it first.");
    expect(await claimJob(rt, "w")).toBeNull();
    rt.clock.move(3 * 86_400_000);
    expect(await fireDue(rt)).toBe(0);
    expect((await installationDTO(rt, await loaded(inst.id))).nextRunAt).toBeNull();
    await control(rt, await loaded(inst.id), "resume");
    const dto = await installationDTO(rt, await loaded(inst.id));
    // Every morning at eight, from now: no catching up on the missed days.
    expect(dto.nextRunAt).toBe("2026-11-12T08:00:00.000Z");
    expect(dto.status).toBe("active");
    expect((await claimJob(rt, "w"))?.installationId).toBe(inst.id);
  });
});

describe("stop", () => {
  it("cancels queued jobs and a waiting one with its question, and is for good", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    expect((await approvalsOf(rt, owner.id, { installationId: inst.id, pendingOnly: true })).length).toBe(1);
    rt.clock.move(60_000);
    await control(rt, await loaded(inst.id), "run");
    await control(rt, await loaded(inst.id), "stop");
    const jobs = await jobsOf(inst.id);
    expect(jobs.map((j) => j.status)).toEqual(["cancelled", "cancelled"]);
    expect(jobs[0]!.reason).toBe("Stopped by its owner before it finished.");
    expect(await approvalsOf(rt, owner.id, { installationId: inst.id, pendingOnly: true })).toEqual([]);
    const refused = await control(rt, await loaded(inst.id), "resume").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ControlRefused);
    expect(await db.select().from(schema.agentTriggers).where(eq(schema.agentTriggers.installationId, inst.id))).toEqual([]);
  });

  it("lets a running job finish the step it is on, then stops it there", async () => {
    const d = restockDefinition();
    const waiting: AgentDefinition = { ...d, steps: [{ ...(d.steps[0] as CodeStepDef), inputs: ["trigger"], tools: ["web.fetch"] }, ...d.steps.slice(1)] };
    const SLOW = `async function run(input, tools) {
  const page = await tools.web.fetch({ url: input.trigger.url });
  return { low: [{ fabric: "Wool felt", metres: 6, minimum: 10, page: page.text }] };
}`;
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: waiting, code: { ...RESTOCK_CODE, find_low: { ...RESTOCK_CODE.find_low, source: SLOW } } }));
    const job = await enqueue(rt, inst, { kind: "manual", url: `${origin}/` });
    const running = runJob(rt, (await claimJob(rt, "w"))!, "w");
    // Mid-step: the page hasn't answered yet.
    await new Promise((r) => setTimeout(r, 200));
    await control(rt, await loaded(inst.id), "stop");
    release();
    await running;
    const [row] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
    expect(row).toMatchObject({ status: "cancelled", reason: "Stopped by its owner." });
    const steps = await db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, job.id));
    expect(steps.map((s) => `${s.stepId}:${s.status}`)).toEqual(["find_low:ok"]);
  });
});
