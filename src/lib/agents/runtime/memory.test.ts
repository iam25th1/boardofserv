// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { AgentDefinition, CodeStepDef } from "@/lib/agents/definition";
import { memoryProblem, MockTools } from "@/lib/agents/toolbox";
import { emptyBench } from "@/lib/agents/types";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, RESTOCK_CODE, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { installationDTO, loadInstallation } from "./installations";
import { claimJob, enqueue, runJob } from "./jobs";

// Memory: real, kept on one installation, only the declared fields, each
// holding its type.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let ana: schema.User;
let ben: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  ana = await addUser(db, "ana");
  ben = await addUser(db, "ben");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"]));
  rt = testRuntime(db);
});

// One code step that remembers what its trigger says, and reads it back.
const remembering = (): AgentDefinition => {
  const d = restockDefinition();
  return {
    ...d,
    memory: [
      { key: "last_order", description: "The last order placed", type: "record" },
      { key: "count", description: "How many runs", type: "number" },
    ],
    steps: [{ ...(d.steps[0] as CodeStepDef), inputs: ["trigger", "memory"], outputs: ["low"], tools: ["memory.get", "memory.set"], next: null }],
  };
};
const REMEMBER = `async function run(input, tools) {
  const before = (await tools.memory.get({ key: "count" })).value;
  await tools.memory.set({ key: "count", value: (before || 0) + 1 });
  if (input.trigger.set) await tools.memory.set(input.trigger.set);
  return { low: { before, started: input.memory } };
}`;
const code = { ...RESTOCK_CODE, find_low: { ...RESTOCK_CODE.find_low, source: REMEMBER } };

async function run(inst: schema.AgentInstallation, trigger: Record<string, unknown>) {
  const job = await enqueue(rt, inst, { kind: "manual", ...trigger });
  rt.clock.move(1000);
  await runJob(rt, (await claimJob(rt, "w"))!, "w");
  return (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id)))[0]!;
}

describe("memory", () => {
  it("is kept between jobs, on that installation only", async () => {
    const p = await publishedAgent(db, ana, { definition: remembering(), code });
    const mine = await installed(rt, ana, p);
    const theirs = await installed(rt, ben, p);
    await run(mine, { set: { key: "last_order", value: { fabric: "Linen", metres: 36 } } });
    const second = await run(mine, {});
    expect(second.status).toBe("done");
    expect(second.state!.bag.low).toEqual({ before: 1, started: { count: 1, last_order: { fabric: "Linen", metres: 36 } } });
    // Ben's copy of the same agent remembers nothing of Ana's.
    const bens = await run(theirs, {});
    expect(bens.state!.bag.low).toEqual({ before: null, started: {} });
    const [row] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, mine.id));
    expect(row!.memory).toEqual({ count: 2, last_order: { fabric: "Linen", metres: 36 } });
    // Its owner sees it on their installation.
    expect((await installationDTO(rt, (await loadInstallation(rt, mine.id))!)).memory).toEqual([
      { key: "last_order", description: "The last order placed", value: { fabric: "Linen", metres: 36 } },
      { key: "count", description: "How many runs", value: 2 },
    ]);
  });

  it("refuses a field the agent doesn't declare, and a value of the wrong type", async () => {
    const inst = await installed(rt, ana, await publishedAgent(db, ana, { definition: remembering(), code }));
    const undeclared = await run(inst, { set: { key: "secrets", value: "x" } });
    expect(undeclared).toMatchObject({ status: "failed", reason: '"Find low stock" failed: Error: "secrets" isn\'t something this agent remembers (it remembers last_order, count).' });
    const wrong = await run(inst, { set: { key: "last_order", value: [1, 2] } });
    expect(wrong.reason).toBe('"Find low stock" failed: Error: "last_order" holds a record (an object).');
    const [row] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst.id));
    expect(Object.keys(row!.memory)).toEqual(["count"]);
  });

  it("checks the same way on the bench", async () => {
    const fields = remembering().memory;
    expect(memoryProblem(fields, "count", "seven")).toBe('"count" holds a number.');
    expect(memoryProblem(fields, "count", null)).toBeNull();
    expect(memoryProblem(fields, "last_order", { lines: "x".repeat(30_000) })).toBe('"last_order" is too large to remember (over 20 KB).');
    const mock = new MockTools(emptyBench(), fields);
    await expect(mock.call("memory.set", { key: "other", value: 1 })).rejects.toThrow('"other" isn\'t something this agent remembers');
    await expect(mock.call("memory.set", { key: "count", value: 3 })).resolves.toEqual({ ok: true });
  });
});
