// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { AgentDefinition } from "@/lib/agents/definition";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, RESTOCK_CODE, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { describeTriggers, nextRun, scheduleSpec } from "../schedule";
import { claimJob, runJob } from "./jobs";
import { MAX_WAITING_MESSAGES, MessageRefused, messagesOf, sendToAgent } from "./messages";
import { fireDue } from "./triggers";

// Triggers on the real migrations, with the clock moved by hand.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "owner");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentInstallations).set({ status: "stopped" });
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running"]));
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
});

const jobsOf = (installationId: string) => db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, installationId));
const triggerOf = async (installationId: string, index = 0) =>
  (await db.select().from(schema.agentTriggers).where(and(eq(schema.agentTriggers.installationId, installationId), eq(schema.agentTriggers.index, index))))[0]!;

describe("a schedule", () => {
  it("fires at its time in the owner's time zone, then moves to the next", async () => {
    // Every morning at eight, Paris time: 07:00 UTC in November.
    const inst = await installed(rt, owner, await publishedAgent(db, owner), { timezone: "Europe/Paris" });
    expect((await triggerOf(inst.id)).nextAt.toISOString()).toBe("2026-11-09T07:00:00.000Z");
    expect(await fireDue(rt)).toBe(0);
    rt.clock.move(60 * 60_000);
    expect(await fireDue(rt)).toBe(1);
    expect(await fireDue(rt)).toBe(0);
    expect((await triggerOf(inst.id)).nextAt.toISOString()).toBe("2026-11-10T07:00:00.000Z");
    const [job] = await jobsOf(inst.id);
    expect(job).toMatchObject({ status: "queued", trigger: { kind: "schedule", at: "2026-11-09T07:00:00.000Z" } });
  });

  it("uses the owner's own time, says it in plain words, and doesn't pile up jobs that haven't started", async () => {
    const p = await publishedAgent(db, owner);
    const inst = await installed(rt, owner, p, { timezone: "UTC", schedule: { at: "06:30", day: null } });
    expect(describeTriggers(p.version.definition!, inst.schedule)).toEqual(["Runs every day at 6:30"]);
    rt.clock.move(31 * 60_000);
    expect(await fireDue(rt)).toBe(1);
    // A day on, the first job still hasn't started (paused elsewhere): no second.
    rt.clock.move(86_400_000);
    expect(await fireDue(rt)).toBe(0);
    expect(await jobsOf(inst.id)).toHaveLength(1);
  });

  it("keeps to the owner's wall clock across daylight saving changes", () => {
    const daily = (at: string) => scheduleSpec({ kind: "schedule", every: "day", at, description: "x" });
    // New York springs forward on 8 March 2026: 7:00 is 11:00 UTC from then.
    expect(nextRun(daily("07:00"), "America/New_York", new Date("2026-03-07T13:00:00Z")).toISOString()).toBe("2026-03-08T11:00:00.000Z");
    // 2:30 doesn't exist that night: it runs at the first minute after, 3:00.
    expect(nextRun(daily("02:30"), "America/New_York", new Date("2026-03-08T05:00:00Z")).toISOString()).toBe("2026-03-08T07:00:00.000Z");
    // Falling back, 1:30 happens twice: the first.
    expect(nextRun(daily("01:30"), "America/New_York", new Date("2026-11-01T04:00:00Z")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("knows a week and the hour", () => {
    const t = { kind: "schedule" as const, every: "week" as const, at: "09:05", description: "x" };
    expect(nextRun(scheduleSpec(t, { at: null, day: 5 }), "Asia/Tokyo", new Date("2026-11-09T00:00:00Z")).toISOString()).toBe("2026-11-13T00:05:00.000Z");
    expect(describeTriggers({ triggers: [t, { kind: "schedule", every: "hour", at: null, description: "x" }] }, { at: null, day: 5 })).toEqual(["Runs every Friday at 9:05", "Runs every hour, on the hour"]);
  });
});

describe("a value check", () => {
  // Fires when any fabric is below its minimum.
  const checking = (): AgentDefinition => {
    const d = restockDefinition();
    return {
      ...d,
      triggers: [{ kind: "check", everyMinutes: 30, watch: "the stock sheet", when: "a fabric runs low", step: "is_low" }],
      steps: [
        ...d.steps,
        { kind: "code", id: "is_low", title: "Is anything low?", inputs: ["settings"], outputs: ["holds"], description: "x", tools: ["sheets.read"], next: null },
      ],
    };
  };
  const IS_LOW = `async function run(input, tools) {
  const { rows } = await tools.sheets.read({ sheet: input.settings.stock_sheet });
  const low = rows.filter((r) => r.metres < r.minimum);
  return { holds: low.length > 0, value: low.map((r) => r.fabric) };
}`;
  const code = { ...RESTOCK_CODE, is_low: { spec: "", status: "approved" as const, source: IS_LOW, rounds: 1, note: null, updatedAt: "" } };
  const setStock = (id: string, metres: number[]) =>
    db
      .update(schema.agentInstallations)
      .set({
        mocks: {
          sheets: { Stock: metres.map((m, i) => ({ fabric: `Fabric ${i}`, metres: m, minimum: 10 })), Orders: [], Suppliers: [] },
          search: {},
          wallet: { balanceUsdc: 0 },
        },
      })
      .where(eq(schema.agentInstallations.id, id));

  it("fires only when the condition turns true, not on every check while it stays true", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: checking(), code }));
    await setStock(inst.id, [20, 30]);
    expect(await fireDue(rt)).toBe(0);
    expect((await triggerOf(inst.id)).holds).toBe(false);
    // Not due again for half an hour.
    rt.clock.move(10 * 60_000);
    await setStock(inst.id, [5, 30]);
    expect(await fireDue(rt)).toBe(0);
    rt.clock.move(20 * 60_000);
    expect(await fireDue(rt)).toBe(1);
    const [job] = await jobsOf(inst.id);
    expect(job!.trigger).toEqual({ kind: "check", watch: "the stock sheet", value: ["Fabric 0"] });
    // Still low: no new job.
    rt.clock.move(30 * 60_000);
    expect(await fireDue(rt)).toBe(0);
    // Restocked, then low again: a new job.
    await setStock(inst.id, [20, 30]);
    rt.clock.move(30 * 60_000);
    expect(await fireDue(rt)).toBe(0);
    await setStock(inst.id, [20, 2]);
    rt.clock.move(30 * 60_000);
    expect(await fireDue(rt)).toBe(1);
    expect(await jobsOf(inst.id)).toHaveLength(2);
  });

  it("says why a check failed, and starts nothing", async () => {
    const broken = { ...code, is_low: { ...code.is_low, source: "async function run() { return { found: true }; }" } };
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: checking(), code: broken }));
    expect(await fireDue(rt)).toBe(0);
    expect((await triggerOf(inst.id)).note).toBe("The check didn't say whether it holds (true or false).");
  });

  it("doesn't check while the installation is paused", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: checking(), code }));
    await setStock(inst.id, [1]);
    await db.update(schema.agentInstallations).set({ status: "paused" }).where(eq(schema.agentInstallations.id, inst.id));
    expect(await fireDue(rt)).toBe(0);
    expect((await triggerOf(inst.id)).holds).toBeNull();
  });
});

describe("a message", () => {
  const messaging = (): AgentDefinition => ({ ...restockDefinition(), triggers: [{ kind: "message", from: "telegram", description: "a message from the owner" }] });

  it("starts a job with the message as its input, and the agent's own messages come back to the box", async () => {
    const SAY = `async function run(input, tools) {
  await tools.telegram.send({ text: "You said: " + input.trigger.text });
  return { low: [] };
}`;
    const d = messaging();
    d.steps = [{ ...(d.steps[0] as Extract<AgentDefinition["steps"][number], { kind: "code" }>), inputs: ["trigger"], tools: ["telegram.send"], next: null }];
    d.actions = [{ id: "tell", tool: "telegram.send", description: "Tell the owner" }];
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: d, code: { find_low: { ...RESTOCK_CODE.find_low, source: SAY } } }));
    const sent = await sendToAgent(rt, inst, d, "How is the linen?");
    const job = (await claimJob(rt, "w"))!;
    expect(job.id).toBe(sent.jobId);
    expect(job.trigger).toMatchObject({ kind: "message", text: "How is the linen?" });
    rt.clock.move(1000);
    await runJob(rt, job, "w");
    expect((await messagesOf(rt, inst.id)).map((m) => `${m.from}: ${m.text}`)).toEqual(["owner: How is the linen?", "agent: You said: How is the linen?"]);
  });

  it("is refused by an agent that takes none, and when too many are waiting", async () => {
    const d = messaging();
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: d }));
    await expect(sendToAgent(rt, inst, restockDefinition(), "hi")).rejects.toThrow("This agent doesn't take messages.");
    for (let i = 0; i < MAX_WAITING_MESSAGES; i++) await sendToAgent(rt, inst, d, `message ${i}`);
    const refused = await sendToAgent(rt, inst, d, "one more").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(MessageRefused);
    expect((refused as MessageRefused).status).toBe(429);
  });
});
