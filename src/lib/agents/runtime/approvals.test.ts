// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { asc, eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { AgentDefinition, CodeStepDef } from "@/lib/agents/definition";
import { addUser, testDb } from "@/test/helperDb";
import { allowanceUsdc, installed, publishedAgent, readyToPay, RESTOCK_CODE, restockDefinition, testRuntime, trusted, withPayments, type TestRuntime } from "@/test/runtimeFixtures";
import { answer, AnswerRefused, approvalsOf, expireDue } from "./approvals";
import { claimJob, enqueue, runJob } from "./jobs";
import { messagesOf } from "./messages";

// Approvals that wait: the job pauses, the owner answers (or doesn't), and
// the job picks up exactly where it paused, nothing done twice.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;
let other: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "owner");
  other = await addUser(db, "other");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentApprovals).set({ status: "cancelled" }).where(eq(schema.agentApprovals.status, "pending"));
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"]));
  rt = testRuntime(db);
  // The order is over the limit, and the answer decides.
  rt.serve = (ids, content) => (ids.includes("over") ? "over" : ids.includes("yes") ? (content.includes('"answer":"Yes"') ? "yes" : "no") : ids[0]!);
});

const jobOf = async (id: string) => (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, id)))[0]!;
const stepsOf = (id: string) => db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, id)).orderBy(asc(schema.agentJobSteps.seq));
async function runOnce(rt: TestRuntime) {
  const job = await claimJob(rt, "w");
  if (job) await runJob(rt, job, "w");
  return job;
}

describe("a question to the owner", () => {
  it("pauses the job with the question, the answers and what happens on each", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runOnce(rt);
    expect(await jobOf(job.id)).toMatchObject({ status: "waiting_for_owner", claimedBy: null });
    const [a] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    expect(a).toMatchObject({
      jobId: job.id,
      agentName: "Fabric restock",
      stepTitle: "Ask the owner",
      kind: "ask",
      options: [
        { label: "Yes", effect: 'It goes on to "Owner said yes?" with "Yes" as your answer.' },
        { label: "No", effect: 'It goes on to "Owner said yes?" with "No" as your answer.' },
      ],
      noAnswer: "After 24 hours with no answer, the job stops.",
      status: "pending",
    });
    expect(a!.question).toContain("Ask the owner");
    expect(new Date(a!.expiresAt).getTime() - rt.now().getTime()).toBe(24 * 3_600_000);
    expect((await stepsOf(job.id)).at(-1)).toMatchObject({ stepId: "ask_owner", status: "waiting" });
    // Nobody else sees it.
    expect(await approvalsOf(rt, other.id)).toEqual([]);
  });

  it("picks up exactly where it paused once answered, nothing done twice", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runOnce(rt);
    const [a] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    await expect(answer(rt, other.id, a!.id, "Yes")).rejects.toThrow("Not found");
    await expect(answer(rt, owner.id, a!.id, "Maybe")).rejects.toThrow("Answer with one of: Yes, No.");
    await answer(rt, owner.id, a!.id, "Yes");
    await expect(answer(rt, owner.id, a!.id, "No")).rejects.toThrow("It was answered already.");
    expect((await jobOf(job.id)).status).toBe("queued");
    await runOnce(rt);
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    const steps = await stepsOf(job.id);
    expect(steps.map((s) => `${s.stepId}:${s.status}`)).toEqual(["find_low:ok", "compare:ok", "check_total:ok", "ask_owner:ok", "approved:ok", "record:ok"]);
    expect(steps[3]!.output).toEqual({ answer: "Yes" });
    expect(steps[4]!.outcome).toBe("yes");
    // Each step before the pause ran once: SERV decided on the total once.
    expect(rt.asked.filter((c) => c.includes("total_usdc"))).toHaveLength(1);
  });

  it("takes the no-answer path when it expires, or stops without one", async () => {
    const d = restockDefinition();
    const withPath: AgentDefinition = { ...d, approvalHours: 2, steps: d.steps.map((s) => (s.id === "ask_owner" ? { ...s, otherwise: "record" } : s)) };
    const a1 = await installed(rt, owner, await publishedAgent(db, owner, { definition: withPath }));
    const j1 = await enqueue(rt, a1, { kind: "manual" });
    await runOnce(rt);
    const [pending] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    expect(pending!.noAnswer).toBe('After 2 hours with no answer, it goes to "Record the order".');
    rt.clock.move(2 * 3_600_000 - 1);
    expect(await expireDue(rt)).toBe(0);
    rt.clock.move(1);
    expect(await expireDue(rt)).toBe(1);
    await runOnce(rt);
    expect(await jobOf(j1.id)).toMatchObject({ status: "done" });
    expect((await stepsOf(j1.id)).map((s) => s.stepId)).toEqual(["find_low", "compare", "check_total", "ask_owner", "record"]);
    expect((await stepsOf(j1.id))[3]!.note).toBe('No answer came in time, so it went to "Record the order".');

    const a2 = await installed(rt, owner, await publishedAgent(db, owner));
    const j2 = await enqueue(rt, a2, { kind: "manual" });
    await runOnce(rt);
    rt.clock.move(24 * 3_600_000);
    await expireDue(rt);
    await runOnce(rt);
    expect(await jobOf(j2.id)).toMatchObject({ status: "cancelled", reason: 'No answer came in time at "Ask the owner", so the job stopped there.' });
  });

  it("in code: the step runs again from the start with the answer, its earlier calls replayed", async () => {
    const d = restockDefinition();
    const asking: AgentDefinition = {
      ...d,
      actions: [...d.actions, { id: "tell", tool: "telegram.send", description: "Tell the owner" }],
      steps: [{ ...(d.steps[0] as CodeStepDef), tools: ["sheets.read", "telegram.send", "telegram.ask"], next: null }],
    };
    const ASK = `async function run(input, tools) {
  await tools.telegram.send({ text: "Looking at your stock." });
  const { answer } = await tools.telegram.ask({ question: "Order linen?", choices: ["Order", "Skip"] });
  await tools.telegram.send({ text: "You said " + answer });
  return { low: answer };
}`;
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: asking, code: { ...RESTOCK_CODE, find_low: { ...RESTOCK_CODE.find_low, source: ASK } } }));
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runOnce(rt);
    const [a] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    expect(a!.options.map((o) => o.label)).toEqual(["Order", "Skip"]);
    expect(a!.noAnswer).toBe('After 24 hours with no answer, "Find low stock" goes on with no answer.');
    rt.clock.move(1000);
    await answer(rt, owner.id, a!.id, "Order");
    await runOnce(rt);
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    expect((await messagesOf(rt, inst.id)).map((m) => m.text)).toEqual(["Looking at your stock.", "You said Order"]);
    expect((await stepsOf(job.id))[0]!.output).toEqual({ low: "Order" });
  });
});

describe("a payment over a rule's limit", () => {
  const paying = (): AgentDefinition => {
    const d = restockDefinition();
    return {
      ...d,
      actions: [{ id: "pay_supplier", tool: "wallet.pay", description: "Pay the supplier", askOver: "approval_over_usdc" }],
      steps: [
        { kind: "code", id: "make_payment", title: "Make the payment", inputs: ["trigger"], outputs: ["payment"], description: "x", tools: [], next: "pay" },
        { kind: "action", id: "pay", title: "Pay the supplier", inputs: ["payment"], outputs: ["paid"], action: "pay_supplier", next: null },
      ],
    };
  };
  const MAKE = "async function run(input) { return { payment: { to: 'Weftworks', amountUsdc: input.trigger.amount, memo: 'linen' } }; }";
  const code = { make_payment: { ...RESTOCK_CODE.find_low, source: MAKE } };

  it("goes through at once within the limit, and waits for a yes over it", async () => {
    withPayments(rt);
    await client.exec("delete from agent_payments;");
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: paying(), code }));
    await readyToPay(rt, inst, { payees: ["Weftworks"], allowanceUsdc: 500 });
    await trusted(rt, inst.versionId);
    const small = await enqueue(rt, inst, { kind: "manual", amount: 100 });
    await runOnce(rt);
    expect(await jobOf(small.id)).toMatchObject({ status: "done" });
    const big = await enqueue(rt, inst, { kind: "manual", amount: 300 });
    rt.clock.move(1000);
    await runOnce(rt);
    expect((await jobOf(big.id)).status).toBe("waiting_for_owner");
    const [a] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    // Over the rule and over its trust band too: both say so, and the band.
    expect(a).toMatchObject({
      kind: "safety",
      reason:
        "It's over the 250.00 USDC a payment that its trust score of 800 (excellent) allows without asking (your own auto limit is 1000.00 USDC). With its trust score of 800 (excellent) it may pay up to 250.00 USDC a payment and 1000.00 USDC a day without asking.",
      question: 'Pay 300 USDC to Weftworks (linen)? This job\'s spending would come to 300 USDC, over your limit of 250 USDC ("Ask me before orders over").',
      options: [
        { label: "Yes", effect: "It pays, and the job is done." },
        { label: "No", effect: "It doesn't pay, and the job stops." },
      ],
    });
    await answer(rt, owner.id, a!.id, "No");
    await runOnce(rt);
    expect(await jobOf(big.id)).toMatchObject({ status: "cancelled", reason: 'You said no at "Pay the supplier", so the job stopped there.' });
    // Only the small payment left its allowance.
    expect(await allowanceUsdc(rt, inst.id)).toBe(400);
  });

  it("refuses an answer to an approval that isn't waiting any more", async () => {
    withPayments(rt);
    await client.exec("delete from agent_payments;");
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: paying(), code }));
    await readyToPay(rt, inst, { payees: ["Weftworks"], allowanceUsdc: 500 });
    await trusted(rt, inst.versionId);
    await enqueue(rt, inst, { kind: "manual", amount: 999 });
    await runOnce(rt);
    const [a] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    rt.clock.move(25 * 3_600_000);
    await expireDue(rt);
    const refused = await answer(rt, owner.id, a!.id, "Yes").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AnswerRefused);
    expect((refused as AnswerRefused).message).toBe("It expired before an answer came.");
  });
});
