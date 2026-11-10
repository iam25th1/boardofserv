// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { answer } from "./runtime/approvals";
import { claimJob, enqueue, runJob } from "./runtime/jobs";
import { JobTools } from "./runtime/tools";
import { AUDIT_PAGE, auditForAdmin, auditForMaker, auditForRenter } from "./audit";
import { Blocked, Halted, Paused } from "./runner";
import { ToolError } from "./toolbox";

// The audit log: every guarded action (a write, a message, a spend) gets a
// line, whatever happens to it, with SERV's check, its reason, who
// approved it and its cost. Nobody can change a line. The renter sees all
// of theirs; the maker sees every renter's with their data hidden; an
// admin sees everything.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let renter: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "audit.maker", "audit_maker");
  renter = await addUser(db, "audit.renter", "audit_renter");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(eq(schema.agentJobs.status, "queued"));
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
});

const linesOf = async (installationId: string) => (await auditForRenter(rt, installationId)).entries;
const record = () => restockDefinition().steps.find((s) => s.id === "record")!;
const ORDER = { sheet: "Orders", rows: [{ fabric: "Linen", metres: 10 }] };

async function runOnce(inst: schema.AgentInstallation) {
  const job = await enqueue(rt, inst, { kind: "manual" });
  await runJob(rt, (await claimJob(rt, "w"))!, "w");
  return (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id)))[0]!;
}

describe("the audit log", () => {
  it("logs an action that ran: what, SERV's check and why, within the renter's settings, and the check's cost", async () => {
    const inst = await installed(rt, renter, await publishedAgent(db, maker));
    expect((await runOnce(inst)).status).toBe("done");
    const lines = await linesOf(inst.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ step: "Record the order", tool: "sheets.write", risk: "write", outcome: "ran", guard: "allow", guardReason: "It fits what the agent is for.", approvedBy: "rules", renter: null });
    expect(lines[0]!.what).toMatch(/^Add \d+ rows? to "Orders"\?$/);
    expect(BigInt(lines[0]!.cost)).toBeGreaterThan(0n);
  });

  it("logs an ask, then the renter's yes and the run, with the check's cost once", async () => {
    rt.guardVerdict = () => ({ verdict: "ask", reason: "This order is larger than usual." });
    const inst = await installed(rt, renter, await publishedAgent(db, maker));
    const job = await runOnce(inst);
    expect(job.status).toBe("waiting_for_owner");
    const [a] = await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.jobId, job.id));
    await answer(rt, renter.id, a!.id, "Yes");
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    const lines = (await linesOf(inst.id)).reverse();
    expect(lines.map((l) => l.outcome)).toEqual(["asked", "ran"]);
    expect(lines[0]).toMatchObject({ guard: "ask", guardReason: "This order is larger than usual.", reason: "Safety check: This order is larger than usual." });
    expect(lines[1]).toMatchObject({ guard: null, approvedBy: "renter" });
    expect(BigInt(lines[0]!.cost)).toBeGreaterThan(0n);
    expect(lines[1]!.cost).toBe("0");
  });

  it("logs a no as declined, a block as blocked, and a limit as stopped", async () => {
    rt.guardVerdict = () => ({ verdict: "ask", reason: "Unusual." });
    const inst = await installed(rt, renter, await publishedAgent(db, maker));
    const job = await runOnce(inst);
    const [a] = await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.jobId, job.id));
    await answer(rt, renter.id, a!.id, "No");
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    expect((await linesOf(inst.id))[0]).toMatchObject({ outcome: "declined", reason: "You answered: No" });

    rt.clock.move(1000);
    rt.guardVerdict = () => ({ verdict: "block", reason: "It sends the orders to a supplier it doesn't use." });
    const blocked = await new JobTools(rt, inst, restockDefinition(), null).call(record(), "sheets.write", ORDER).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(Blocked);
    expect((await linesOf(inst.id))[0]).toMatchObject({ outcome: "blocked", guard: "block", guardReason: "It sends the orders to a supplier it doesn't use." });

    rt.guardVerdict = () => ({ verdict: "allow", reason: "Fine." });
    const busy = await installed(rt, renter, await publishedAgent(db, maker));
    const j = await enqueue(rt, busy, { kind: "manual" });
    await db.update(schema.agentJobs).set({ actions: 40 }).where(eq(schema.agentJobs.id, j.id));
    const stopped = await new JobTools(rt, busy, restockDefinition(), { ...j, actions: 40 }).call(record(), "sheets.write", ORDER).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(Halted);
    expect((await linesOf(busy.id))[0]).toMatchObject({ outcome: "stopped", guard: null });
  });

  it("logs a failure with its reason, and a question to the renter as asked", async () => {
    const inst = await installed(rt, renter, await publishedAgent(db, maker));
    const failed = await new JobTools(rt, inst, restockDefinition(), null).call(record(), "sheets.write", { sheet: "Payroll", rows: [{ a: 1 }] }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ToolError);
    expect((await linesOf(inst.id))[0]).toMatchObject({ outcome: "failed", approvedBy: "rules" });
    expect((await linesOf(inst.id))[0]!.reason).toContain("wasn't given a sheet called \"Payroll\"");
    const ask = restockDefinition().steps.find((s) => s.id === "ask_owner")!;
    const paused = await new JobTools(rt, inst, restockDefinition(), null).call(ask, "telegram.ask", { question: "Order 10 metres of linen?" }).catch((e: unknown) => e);
    expect(paused).toBeInstanceOf(Paused);
    expect((await linesOf(inst.id))[0]).toMatchObject({ tool: "telegram.ask", outcome: "asked", what: 'Ask you: "Order 10 metres of linen?"', guard: "allow" });
  });

  it("never logs a read", async () => {
    const inst = await installed(rt, renter, await publishedAgent(db, maker));
    const find = restockDefinition().steps.find((s) => s.id === "find_low")!;
    await new JobTools(rt, inst, restockDefinition(), null).call(find, "sheets.read", { sheet: "Stock" });
    expect(await linesOf(inst.id)).toEqual([]);
  });

  it("can't be changed or removed, even straight in the database", async () => {
    const inst = await installed(rt, renter, await publishedAgent(db, maker));
    await new JobTools(rt, inst, restockDefinition(), null).call(record(), "sheets.write", ORDER);
    await expect(db.update(schema.agentAudit).set({ outcome: "blocked" }).where(eq(schema.agentAudit.installationId, inst.id))).rejects.toHaveProperty("cause.message", expect.stringMatching(/append-only/));
    await expect(db.delete(schema.agentAudit).where(eq(schema.agentAudit.installationId, inst.id))).rejects.toHaveProperty("cause.message", expect.stringMatching(/append-only/));
    expect((await linesOf(inst.id))[0]!.outcome).toBe("ran");
  });

  it("is written only by audit.ts: no other file touches the table", () => {
    const root = join(__dirname, "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk(root);
    const touching = files.filter((f) => /\bagentAudit\b/.test(readFileSync(f, "utf8"))).map((f) => relative(root, f));
    expect(touching.sort()).toEqual(["lib/agents/audit.ts", "lib/db/schema.ts"]);
  });
});

describe("who sees what", () => {
  it("shows the maker every renter's lines with their data hidden, renters by number and their own as You", async () => {
    const p = await publishedAgent(db, maker);
    const other = await addUser(db, "audit.other", "audit_other");
    const first = await installed(rt, renter, p);
    const second = await installed(rt, other, p);
    const own = await installed(rt, maker, p);
    rt.guardVerdict = () => ({ verdict: "ask", reason: "It writes 10 metres of Linen for audit_renter's shop." });
    for (const inst of [first, second, own]) await new JobTools(rt, inst, restockDefinition(), null).call(record(), "sheets.write", ORDER).catch(() => null);
    const seen = (await auditForMaker(rt, p.agent)).entries;
    expect(seen.map((l) => l.renter).sort()).toEqual(["Renter 1", "Renter 2", "You"]);
    for (const l of seen) expect(l).toMatchObject({ what: null, reason: null, guardReason: null, spent: null, guard: "ask", outcome: "asked", step: "Record the order" });
    const text = JSON.stringify(seen);
    for (const secret of ["Linen", "audit_renter", "audit_other", "Orders", renter.id, other.id]) expect(text).not.toContain(secret);
    // Another maker's agent's lines aren't in it.
    const elsewhere = await installed(rt, renter, await publishedAgent(db, other));
    await new JobTools(rt, elsewhere, restockDefinition(), null).call(record(), "sheets.write", ORDER).catch(() => null);
    expect((await auditForMaker(rt, p.agent)).entries).toHaveLength(3);
  });

  it("shows an admin everything with renters named, and pages from the newest", async () => {
    const inst = await installed(rt, renter, await publishedAgent(db, maker));
    const tools = new JobTools(rt, inst, restockDefinition(), null);
    for (let n = 0; n < AUDIT_PAGE + 3; n++) {
      rt.clock.move(3000);
      await tools.call(record(), "sheets.write", { sheet: "Orders", rows: [{ fabric: "Linen", metres: n + 1 }] });
    }
    const one = await auditForAdmin(rt, { installationId: inst.id });
    expect(one.entries).toHaveLength(AUDIT_PAGE);
    expect(one.entries[0]).toMatchObject({ renter: "@audit_renter", agent: restockDefinition().name });
    expect(one.next).not.toBeNull();
    const two = await auditForAdmin(rt, { installationId: inst.id, before: one.next });
    expect(two.entries).toHaveLength(3);
    expect(two.next).toBeNull();
    expect(new Set([...one.entries, ...two.entries].map((e) => e.id)).size).toBe(AUDIT_PAGE + 3);
    expect(Date.parse(one.entries.at(-1)!.at)).toBeGreaterThan(Date.parse(two.entries[0]!.at));
    // A cursor that isn't one starts from the newest.
    expect((await auditForAdmin(rt, { installationId: inst.id, before: "'; drop table agent_audit; --" })).entries[0]!.id).toBe(one.entries[0]!.id);
  });
});
