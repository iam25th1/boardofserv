// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { asc, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { AgentDefinition } from "@/lib/agents/definition";
import restock from "@/lib/agents/examples/restock.json";
import { SUPPLIERS_HTML } from "@/lib/agents/examples/supplierPage";
import type { BenchData, StepCode } from "@/lib/agents/types";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { answer, approvalsOf } from "./approvals";
import { fireDue } from "./triggers";
import { jobWorker } from "./worker";

// The example restock agent, running for real for a test owner: on its
// schedule, in their time zone, reading its stock from the stand-in sheet
// and its suppliers' prices from a page this test serves itself, with SERV
// answered by the test. It notices what's low, picks the best supplier,
// waits for the owner's yes over their limit, then records the order and
// remembers it.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;
let server: Server;
let origin: string;
let pageHits = 0;

const definition = restock.definition as AgentDefinition;
const code = Object.fromEntries(Object.entries(restock.code).map(([k, c]) => [k, { ...c, spec: "", updatedAt: "" } as StepCode]));

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "shopkeeper");
  server = createServer((req, res) => {
    if (req.url === "/prices") {
      pageHits += 1;
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SUPPLIERS_HTML);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 06:30 in Paris on a Monday.
  rt = testRuntime(db, new Date("2026-11-09T05:30:00Z"));
  rt.web = { allowOrigins: [origin] };
  // SERV: the order is over the owner's limit; the owner's answer decides.
  rt.serve = (ids, content) => {
    if (ids.includes("needs_approval")) return "needs_approval";
    if (ids.includes("approved")) return /"answer":"Yes"/.test(content) ? "approved" : "declined";
    return ids[0]!;
  };
});
afterAll(async () => {
  server.close();
  await client.close();
});

async function cycle(worker: ReturnType<typeof jobWorker>) {
  await worker.cycle();
  await Promise.all(worker.running());
}

describe("the example, running for real", () => {
  it("runs on its schedule, asks over the limit, and records the order on yes", async () => {
    const p = await publishedAgent(db, owner, { definition, code, bench: restock.bench as BenchData });
    const inst = await installed(rt, owner, p, {
      settings: { stock_sheet: "Stock", suppliers_page: `${origin}/prices`, orders_sheet: "Orders", approval_limit: 50, max_delivery_days: 7 },
      rules: { approval_limit: "50" },
      timezone: "Europe/Paris",
    });
    const worker = jobWorker(rt);

    // Not before eight, Paris time.
    await cycle(worker);
    expect(await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, inst.id))).toEqual([]);
    rt.clock.move(90 * 60_000);
    await cycle(worker);
    const [job] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, inst.id));
    expect(job).toMatchObject({ status: "waiting_for_owner", trigger: { kind: "schedule", at: "2026-11-09T07:00:00.000Z" } });
    expect(pageHits).toBe(1);

    // It read the stand-in stock sheet and the real page, and found what's low.
    const steps = async () => db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, job!.id)).orderBy(asc(schema.agentJobSteps.seq));
    const read = (await steps())[0]!;
    expect(read.tools.map((t) => t.tool).sort()).toEqual(["sheets.read", "web.fetch"]);
    const orders = (read.output as { orders_to_place: { fabric: string; supplier: string }[] }).orders_to_place;
    expect(orders.map((o) => o.fabric).sort()).toEqual(["Canvas, heavy", "Linen, natural", "Wool felt"]);
    // Harbor Cloth's linen is cheapest but takes 9 days, past the 7 allowed.
    expect(orders.find((o) => o.fabric === "Linen, natural")!.supplier).toBe("Weftworks");
    expect((await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job!.id)))[0]!.state!.untrusted).toContain("orders_to_place");

    // The owner is asked, with what happens on each answer.
    const [ask] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    expect(ask).toMatchObject({ agentName: definition.name, kind: "ask", stepTitle: definition.steps.find((s) => s.id === "ask_approval")!.title });
    expect(ask!.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(ask!.noAnswer).toMatch(/^After 24 hours with no answer, it goes to "/);

    // Yes: it picks up at the question and records the order.
    rt.clock.move(10 * 60_000);
    await answer(rt, owner.id, ask!.id, "Yes");
    await cycle(worker);
    const [after] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job!.id));
    expect(after).toMatchObject({ status: "done", reason: "It reached the end of its steps." });
    expect((await steps()).map((s) => s.stepId)).toEqual(definition.steps.map((s) => s.id));
    expect(pageHits).toBe(1);
    const [row] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst.id));
    expect(row!.mocks.sheets.Orders!.length).toBe(3);
    expect(row!.memory.last_order).toMatchObject({ lines: expect.any(Array) });
    expect((row!.memory.last_order as { lines: unknown[] }).lines).toHaveLength(3);

    // And again the next morning.
    rt.clock.move(86_400_000);
    await cycle(worker);
    expect(await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, inst.id))).toHaveLength(2);
    expect(await fireDue(rt)).toBe(0);
    worker.stop();
  });
});
