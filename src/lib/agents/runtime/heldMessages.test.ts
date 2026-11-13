// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { checkDefinition, type AgentDefinition } from "@/lib/agents/definition";
import type { StepCode } from "@/lib/agents/types";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, readyToPay, restockDefinition, testRuntime, trusted, withPayments, type TestRuntime } from "@/test/runtimeFixtures";
import { deliverTelegram, resetTelegramHolds } from "@/lib/telegram/deliver";
import { answer, approvalsOf, expireDue } from "./approvals";
import { cancelJob, claimJob, enqueue, runJob } from "./jobs";
import { messagesOf } from "./messages";

// Messages that carry links the owner never gave the agent wait for their
// yes, all of a run's together: one question at the end of the run listing
// each message and its links, with Yes to all, No to all and Pick one by
// one. Nothing is sent before the yes. A payment asks on its own, as ever.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "held.owner");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentApprovals).set({ status: "cancelled" }).where(eq(schema.agentApprovals.status, "pending"));
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"]));
  rt = testRuntime(db);
  resetTelegramHolds();
});

const ok = (source: string): StepCode => ({ spec: "", status: "approved", source, rounds: 1, note: null, updatedAt: "" });

const PROJECTS = ["Tidewatch", "Shelf Life", "Commute Buddy", "Recipe Remix", "Lantern"];

// Five projects, a message about each with its demo link; with `pays`, a
// payment after them that asks on its own (over the rule's limit).
function sender(pays = false): { definition: AgentDefinition; code: Record<string, StepCode> } {
  const base = restockDefinition();
  const c = checkDefinition({
    ...base,
    name: "Demo link sender",
    job: { does: "Sends you each project's demo link.", done: "Every project's link was sent." },
    triggers: [{ kind: "schedule", every: "day", at: "09:00", description: "Every day at 9:00" }],
    settings: [],
    memory: [],
    steps: [
      { id: "make", title: "List the projects", kind: "code", inputs: ["trigger"], outputs: ["projects"], description: "Return projects, each with its name and demo link.", tools: [], next: "each" },
      { id: "each", title: "Each project", kind: "loop", inputs: ["projects"], outputs: [], over: "projects", item: "project", body: "write", gather: [], next: pays ? "make_payment" : null },
      { id: "write", title: "Write the message", kind: "code", inputs: ["project"], outputs: ["message"], description: "Return message as telegram.send's arguments { text } naming the project and its demo link.", tools: [], next: "send" },
      { id: "send", title: "Send the link", kind: "action", action: "send_link", inputs: ["message"], outputs: [], next: null },
      ...(pays
        ? [
            { id: "make_payment", title: "Make the payment", kind: "code" as const, inputs: ["trigger"], outputs: ["payment"], description: "Return payment as wallet.pay's arguments.", tools: [], next: "pay" },
            { id: "pay", title: "Pay the supplier", kind: "action" as const, action: "pay_supplier", inputs: ["payment"], outputs: ["paid"], next: null },
          ]
        : []),
    ],
    actions: [{ id: "send_link", tool: "telegram.send", description: "Send you the demo link" }, ...(pays ? [{ id: "pay_supplier", tool: "wallet.pay" as const, description: "Pay the supplier", askOver: "approval_over_usdc" }] : [])],
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return {
    definition: c.definition,
    code: {
      make: ok(`async function run() { return { projects: ${JSON.stringify(PROJECTS.map((name) => ({ name, demo: `https://${name.toLowerCase().replace(/ /g, "-")}.example/demo` })))} }; }`),
      write: ok("async function run(input) { return { message: { text: input.project.name + ': try the demo at ' + input.project.demo } }; }"),
      ...(pays ? { make_payment: ok("async function run() { return { payment: { to: 'Weftworks', amountUsdc: 300, memo: 'linen' } }; }") } : {}),
    },
  };
}

async function runOnce() {
  const job = await claimJob(rt, "w");
  if (job) await runJob(rt, job, "w");
  return job;
}
const jobOf = async (id: string) => (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, id)))[0]!;
const said = async (installationId: string) => (await messagesOf(rt, installationId)).filter((m) => m.from === "agent").map((m) => m.text);
const pending = () => approvalsOf(rt, owner.id, { pendingOnly: true });

async function started(pays = false) {
  const inst = await installed(rt, owner, await publishedAgent(db, owner, sender(pays)));
  const job = await enqueue(rt, inst, { kind: "manual" });
  await runOnce();
  return { inst, job };
}

describe("a run's messages with links the owner never gave", () => {
  it("make one ask at the end of the run, listing each message and its links, and nothing goes before the yes", async () => {
    const { inst, job } = await started();
    expect((await jobOf(job.id)).status).toBe("waiting_for_owner");
    const asks = await pending();
    expect(asks).toHaveLength(1);
    const [a] = asks;
    expect(a!.options.map((o) => o.label)).toEqual(["Yes to all", "No to all", "Pick one by one"]);
    expect(a!.question).toMatch(/^Send these 5 messages to you\?/);
    for (const p of PROJECTS) {
      expect(a!.question).toContain(`${p}: try the demo`);
      expect(a!.question).toContain(`https://${p.toLowerCase().replace(/ /g, "-")}.example/demo`);
    }
    expect(a!.reason).toContain("you didn't give it");
    expect(a!.noAnswer).toBe("After 24 hours with no answer, none of them is sent.");
    // Not in the app's message box, and not in Telegram: only the question is.
    expect(await said(inst.id)).toEqual([]);
    await deliverTelegram(rt);
    const sent = rt.net.telegram("sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.reply_markup).toBeTruthy();
  });

  it("all go on Yes to all", async () => {
    const { inst, job } = await started();
    const [a] = await pending();
    await answer(rt, owner.id, a!.id, "Yes to all");
    await runOnce();
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    expect((await said(inst.id)).sort()).toEqual(PROJECTS.map((p) => `${p}: try the demo at https://${p.toLowerCase().replace(/ /g, "-")}.example/demo`).sort());
    await deliverTelegram(rt);
    expect(rt.net.telegram("sendMessage").filter((m) => !m.reply_markup)).toHaveLength(5);
  });

  it("none go on No to all, or with no answer", async () => {
    const { inst, job } = await started();
    const [a] = await pending();
    await answer(rt, owner.id, a!.id, "No to all");
    await runOnce();
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    expect(await said(inst.id)).toEqual([]);
    expect(await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.jobId, job.id))).toEqual([]);

    const again = await enqueue(rt, inst, { kind: "manual" });
    await runOnce();
    rt.clock.move(25 * 3_600_000);
    expect(await expireDue(rt)).toBe(1);
    await runOnce();
    expect(await jobOf(again.id)).toMatchObject({ status: "done" });
    expect(await said(inst.id)).toEqual([]);
    await deliverTelegram(rt);
    expect(rt.net.telegram("sendMessage").filter((m) => !m.reply_markup)).toEqual([]);
  });

  it("are asked about one at a time on Pick one by one, and only the ones said yes to go", async () => {
    const { inst, job } = await started();
    const [a] = await pending();
    await answer(rt, owner.id, a!.id, "Pick one by one");
    await runOnce();
    const each = await pending();
    expect(each).toHaveLength(5);
    expect(each.every((x) => x.options.map((o) => o.label).join() === "Yes,No")).toBe(true);
    for (const x of each) await answer(rt, owner.id, x.id, /Tidewatch|Lantern/.test(x.question) ? "Yes" : "No");
    // Waiting until every one has its answer, then done.
    await runOnce();
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    expect((await said(inst.id)).map((t) => t.split(":")[0]).sort()).toEqual(["Lantern", "Tidewatch"]);
  });

  it("go nowhere when the job is cancelled while it asks", async () => {
    const { inst, job } = await started();
    await cancelJob(rt, owner.id, job.id);
    expect(await jobOf(job.id)).toMatchObject({ status: "cancelled" });
    expect(await pending()).toEqual([]);
    expect(await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.jobId, job.id))).toEqual([]);
    expect(await said(inst.id)).toEqual([]);
  });

  it("never take a payment with them: it asks on its own, as ever", async () => {
    withPayments(rt);
    await client.exec("delete from agent_payments;");
    const inst = await installed(rt, owner, await publishedAgent(db, owner, sender(true)));
    await readyToPay(rt, inst, { payees: ["Weftworks"], allowanceUsdc: 500 });
    await trusted(rt, inst.versionId);
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runOnce();
    // The payment's own question first, with nothing about the messages in it.
    const [pay] = await pending();
    expect(pay!.question).toMatch(/^Pay 300 USDC to Weftworks/);
    expect(pay!.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(await said(inst.id)).toEqual([]);
    await answer(rt, owner.id, pay!.id, "Yes");
    await runOnce();
    // Then the messages', on their own.
    const [msgs] = await pending();
    expect(msgs!.question).toMatch(/^Send these 5 messages to you\?/);
    expect(msgs!.question).not.toContain("USDC");
    await answer(rt, owner.id, msgs!.id, "Yes to all");
    await runOnce();
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    expect(await said(inst.id)).toHaveLength(5);
  });
});
