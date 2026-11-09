// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, sheetRows, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { answer } from "./runtime/approvals";
import { claimJob, enqueue, runJob } from "./runtime/jobs";
import { JobTools } from "./runtime/tools";
import { GUARD_DOWN, GUARD_SCHEMA, readGuard } from "./guard";
import { Paused } from "./runner";

// SERV's action guard on real jobs: it reads every write, message and spend
// before it happens; allow lets it through, ask waits for the renter with
// the reason, block stops the step and says why; when SERV can't answer it
// asks, never allows; the same call in one run is checked once.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "guard.owner");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(eq(schema.agentJobs.status, "queued"));
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
});

const jobOf = async (id: string) => (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, id)))[0]!;
async function runOnce(inst: schema.AgentInstallation) {
  const job = await enqueue(rt, inst, { kind: "manual" });
  await runJob(rt, (await claimJob(rt, "w"))!, "w");
  return jobOf(job.id);
}

describe("the action guard", () => {
  it("asks SERV before the order is written, with the agent's purpose and the renter's settings, and lets it through on allow", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const job = await runOnce(inst);
    expect(job.status).toBe("done");
    expect(rt.guarded).toHaveLength(1);
    const asked = rt.guarded[0]!;
    expect(asked).toContain(`What it is for: ${restockDefinition().job.does}`);
    expect(asked).toContain("The action: Add the order to the orders sheet (sheets.write, risk write)");
    expect(asked).toContain('"Ask me before orders over":"250"');
    expect(sheetRows(rt, inst, "orders_sheet").length).toBeGreaterThan(0);
  });

  it("waits for the renter on ask, with SERV's reason, and goes on after a yes", async () => {
    rt.guardVerdict = () => ({ verdict: "ask", reason: "This order is larger than usual for this shop." });
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const job = await runOnce(inst);
    expect(job.status).toBe("waiting_for_owner");
    const [a] = await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.jobId, job.id));
    expect(a).toMatchObject({ kind: "safety", reason: "Safety check: This order is larger than usual for this shop." });
    expect(a!.question).toMatch(/^Add \d+ rows? to "Orders"\?$/);
    expect(sheetRows(rt, inst, "orders_sheet")).toEqual([]);
    await answer(rt, owner.id, a!.id, "Yes");
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    expect((await jobOf(job.id)).status).toBe("done");
    // The yes covered it: SERV wasn't asked again.
    expect(rt.guarded).toHaveLength(1);
    expect(sheetRows(rt, inst, "orders_sheet").length).toBeGreaterThan(0);
  });

  it("stops the step on block and says why, with nothing written", async () => {
    rt.guardVerdict = () => ({ verdict: "block", reason: "The rows send the shop's orders to a supplier it doesn't use." });
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const job = await runOnce(inst);
    expect(job).toMatchObject({ status: "failed", reason: '"Record the order" was stopped by the safety check: The rows send the shop\'s orders to a supplier it doesn\'t use.' });
    expect(sheetRows(rt, inst, "orders_sheet")).toEqual([]);
    expect(await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.jobId, job.id))).toEqual([]);
  });

  it("asks, never allows, when SERV is down, isn't set up or the site's day is spent", async () => {
    for (const setup of [() => (rt.guardVerdict = () => "down"), () => (rt.serv = () => null), () => (rt.siteRefusal = async () => "boardofserv has hit today's limit.")]) {
      rt = testRuntime(db);
      rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
      setup();
      // With SERV gone the decision can't be made either: check the order step directly.
      const inst = await installed(rt, owner, await publishedAgent(db, owner));
      const d = restockDefinition();
      const record = d.steps.find((s) => s.id === "record")!;
      const paused = (await new JobTools(rt, inst, d, null).call(record, "sheets.write", { sheet: "Orders", rows: [{ fabric: "Linen" }] }).catch((e: unknown) => e)) as Paused;
      expect(paused).toBeInstanceOf(Paused);
      expect(paused.ask).toMatchObject({ kind: "safety", reason: GUARD_DOWN });
      expect(sheetRows(rt, inst, "orders_sheet")).toEqual([]);
    }
  });

  it("checks the same call once in a run, and a different one again", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const d = restockDefinition();
    const record = d.steps.find((s) => s.id === "record")!;
    const tools = new JobTools(rt, inst, d, null);
    const rows = { sheet: "Orders", rows: [{ fabric: "Linen", metres: 10 }] };
    await tools.call(record, "sheets.write", rows);
    await tools.call(record, "sheets.write", rows);
    expect(rt.guarded).toHaveLength(1);
    await tools.call(record, "sheets.write", { ...rows, rows: [{ fabric: "Wool", metres: 4 }] });
    expect(rt.guarded).toHaveLength(2);
    // A new run asks afresh.
    await new JobTools(rt, inst, d, null).call(record, "sheets.write", rows);
    expect(rt.guarded).toHaveLength(3);
  });
});

describe("the guard's answer", () => {
  it("is structured output SERV takes: no nullable and no numeric ranges", () => {
    const text = JSON.stringify(GUARD_SCHEMA);
    for (const word of ["nullable", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", '"null"']) expect(text).not.toContain(word);
  });

  it("reads anything but allow, ask or block as ask", () => {
    const call = (content: string | null) => ({ content, outcome: "ok" as const, provider: "serv" as const, model: "m", promptTokens: 1, completionTokens: 1, totalMs: 1, failures: [] });
    expect(readGuard(call(JSON.stringify({ verdict: "allow", reason: "Fine." })))).toEqual({ verdict: "allow", reason: "Fine.", fallback: false });
    for (const bad of [null, "not json", JSON.stringify({ verdict: "yes" }), JSON.stringify({ reason: "x" })]) expect(readGuard(call(bad))).toEqual({ verdict: "ask", reason: GUARD_DOWN, fallback: true });
  });
});
