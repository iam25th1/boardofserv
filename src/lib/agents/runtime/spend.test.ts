// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { asc, eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { checkDefinition, type AgentDefinition } from "@/lib/agents/definition";
import type { StepCode } from "@/lib/agents/types";
import { addUser, testDb } from "@/test/helperDb";
import { allowanceUsdc, installed, ownSheet, publishedAgent, readyToPay, sheetRows, testRuntime, withPayments, type TestRuntime } from "@/test/runtimeFixtures";
import { answer, approvalsOf } from "./approvals";
import { claimJob, enqueue, runJob } from "./jobs";

// The spending guard counts the whole job and the whole day, not each
// action or line, whatever the agent's own steps decided.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "spender");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentApprovals).set({ status: "cancelled" }).where(eq(schema.agentApprovals.status, "pending"));
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"]));
  await db.update(schema.agentInstallations).set({ status: "stopped" });
  rt = testRuntime(db);
  // Payments go out on a chain in memory, from each installation's allowance.
  withPayments(rt, { treasuryUsdc: 100_000_000_000n });
  await client.exec("delete from agent_payments;");
  // SERV judges each line on its own, as it did: every line is within.
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
});

const ok = (source: string): StepCode => ({ spec: "", status: "approved", source, rounds: 1, note: null, updatedAt: "" });
const def = (raw: unknown): AgentDefinition => {
  const c = checkDefinition(raw);
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
};
const base = {
  format: 1,
  job: { does: "Pays suppliers.", done: "Everyone is paid." },
  triggers: [{ kind: "schedule", every: "day", at: "09:00", description: "Every morning" }],
  settings: [],
  memory: [],
  limits: { maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.5 },
};
const rules = [
  { key: "job_limit", label: "Ask me before a job spends over", type: "usdc", value: "50", help: "Per job." },
  { key: "day_limit", label: "Ask me before a day's spending goes over", type: "usdc", value: "1000", help: "Per day." },
];

async function runOnce() {
  const job = await claimJob(rt, "w");
  if (job) await runJob(rt, job, "w");
  return job;
}
const jobOf = async (id: string) => (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, id)))[0]!;
// What its allowance has left, in whole USDC (it starts with 500).
const walletOf = (id: string) => allowanceUsdc(rt, id);
const SUPPLIERS = ["Supplier 1", "Supplier 2", "Supplier 3", "Supplier 4", "Supplier 5"];
async function paying(inst: schema.AgentInstallation) {
  await readyToPay(rt, inst, { payees: SUPPLIERS, allowanceUsdc: 500 });
  return inst;
}
const spentBy = (jobId: string) => db.select().from(schema.agentSpend).where(eq(schema.agentSpend.jobId, jobId)).orderBy(asc(schema.agentSpend.createdAt));
async function yes() {
  const [a] = await approvalsOf(rt, owner.id, { pendingOnly: true });
  rt.clock.move(1000);
  await answer(rt, owner.id, a!.id, "Yes");
  await runOnce();
  return a!;
}

// Five payments of 40, one action step each, after SERV's own (per-line)
// look says they are all within.
const fivePayments = () =>
  def({
    ...base,
    name: "Five payments",
    rules,
    steps: [
      { id: "make", kind: "code", title: "Make the payments", description: "Five payments of 40.", inputs: [], outputs: ["lines", "p1", "p2", "p3", "p4", "p5"], tools: [], next: "look" },
      { id: "look", kind: "decision", title: "Each line within?", prompt: "Is each payment within job_limit?", inputs: ["lines", "rules"], outputs: [], outcomes: [{ id: "within", label: "Within", next: "pay_1" }, { id: "over", label: "Over", next: null }] },
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `pay_${n}`, kind: "action", title: `Payment ${n}`, inputs: [`p${n}`], outputs: [], action: "pay", next: n < 5 ? `pay_${n + 1}` : null })),
    ],
    actions: [{ id: "pay", tool: "wallet.pay", description: "Pay a supplier", askOver: "job_limit", askOverDay: "day_limit" }],
  });
const MAKE = `async function run() {
  const p = (n) => ({ to: "Supplier " + n, amountUsdc: 40 });
  return { lines: [1, 2, 3, 4, 5].map(p), p1: p(1), p2: p(2), p3: p(3), p4: p(4), p5: p(5) };
}`;

describe("a job's running total", () => {
  it("five actions of 40 against a limit of 50 ask before the second goes through, and each after it", async () => {
    const inst = await paying(await installed(rt, owner, await publishedAgent(db, owner, { definition: fivePayments(), code: { make: ok(MAKE) } })));
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runOnce();
    expect((await jobOf(job.id)).status).toBe("waiting_for_owner");
    // The first went through; the second waits.
    expect(await walletOf(inst.id)).toBe(460);
    const [a] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    expect(a).toMatchObject({
      kind: "over_limit",
      stepTitle: "Payment 2",
      question: 'Pay 40 USDC to Supplier 2? This job\'s spending would come to 80 USDC, over your limit of 50 USDC ("Ask me before a job spends over").',
    });
    expect(a!.options[0]).toEqual({ label: "Yes", effect: 'It pays, then goes on to "Payment 3".' });
    // Each one after it asks again, with the total so far.
    const asked = [a!.question];
    await yes();
    for (let i = 0; i < 3; i++) {
      const [next] = await approvalsOf(rt, owner.id, { pendingOnly: true });
      asked.push(next!.question);
      await yes();
    }
    expect(asked.map((q) => /come to (\d+) USDC/.exec(q)![1])).toEqual(["80", "120", "160", "200"]);
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    expect(await walletOf(inst.id)).toBe(300);
    expect((await spentBy(job.id)).map((s) => Number(s.amountUsdc))).toEqual([40, 40, 40, 40, 40]);
  });

  it("counts payments made inside one code step too, nothing paid twice on the way", async () => {
    const d = def({
      ...base,
      name: "Payments in code",
      rules,
      steps: [{ id: "pay_all", kind: "code", title: "Pay everyone", description: "Pay five suppliers 40 each.", inputs: [], outputs: ["paid"], tools: ["wallet.pay"], next: null }],
      actions: [{ id: "pay", tool: "wallet.pay", description: "Pay a supplier", askOver: "job_limit" }],
    });
    const PAY_ALL = `async function run(input, tools) {
  const paid = [];
  for (let n = 1; n <= 5; n++) paid.push((await tools.wallet.pay({ to: "Supplier " + n, amountUsdc: 40 })).txId);
  return { paid };
}`;
    const inst = await paying(await installed(rt, owner, await publishedAgent(db, owner, { definition: d, code: { pay_all: ok(PAY_ALL) } })));
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runOnce();
    expect(await walletOf(inst.id)).toBe(460);
    for (let i = 0; i < 4; i++) await yes();
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    expect(await walletOf(inst.id)).toBe(300);
    expect(await spentBy(job.id)).toHaveLength(5);
  });

  it("a no stops the spending there", async () => {
    const inst = await paying(await installed(rt, owner, await publishedAgent(db, owner, { definition: fivePayments(), code: { make: ok(MAKE) } })));
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runOnce();
    const [a] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    await answer(rt, owner.id, a!.id, "No");
    await runOnce();
    expect(await jobOf(job.id)).toMatchObject({ status: "cancelled", reason: 'You said no at "Payment 2", so the job stopped there.' });
    expect(await walletOf(inst.id)).toBe(460);
  });

  it("order rows count by their amount column, however each line compares", async () => {
    const d = def({
      ...base,
      name: "Orders",
      settings: [{ key: "orders_sheet", label: "Orders", type: "sheet", help: "Where orders go.", choices: [] }],
      rules,
      steps: [
        { id: "make", kind: "code", title: "Make the order", description: "Two lines of 30.", inputs: ["settings"], outputs: ["order"], tools: [], next: "write" },
        { id: "write", kind: "action", title: "Write the order", inputs: ["order"], outputs: [], action: "write_order", next: null },
      ],
      actions: [{ id: "write_order", tool: "sheets.write", description: "Add order rows", amountColumn: "total_cost_usdc", askOver: "job_limit" }],
    });
    const ORDER = `async function run(input) {
  return { order: { sheet: input.settings.orders_sheet, rows: [{ fabric: "Linen", total_cost_usdc: 30 }, { fabric: "Wool", total_cost_usdc: 30 }] } };
}`;
    const p = await publishedAgent(db, owner, { definition: d, code: { make: ok(ORDER) } });
    const inst = await installed(rt, owner, p, { settings: { orders_sheet: ownSheet(rt, { Orders: [] }).answer("Orders") } });
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runOnce();
    const [a] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    expect(a!.question).toBe('Write 2 rows to "Orders", worth 60 USDC? This job\'s spending would come to 60 USDC, over your limit of 50 USDC ("Ask me before a job spends over").');
    expect(a!.options[0]!.effect).toBe("It goes ahead, and the job is done.");
    expect(sheetRows(rt, inst, "orders_sheet")).toEqual([]);
    await yes();
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    expect(sheetRows(rt, inst, "orders_sheet")).toHaveLength(2);
  });
});

describe("a day's total", () => {
  it("asks once the installation's spending for the day would go over the daily rule", async () => {
    const inst = await paying(
      await installed(rt, owner, await publishedAgent(db, owner, { definition: fivePayments(), code: { make: ok(MAKE) } }), {
        rules: { job_limit: "1000", day_limit: "100" },
        timezone: "America/New_York",
      }),
    );
    // 40 x 5 = 200 a job: within the job's 1000, but over the day's 100 at
    // the third payment.
    const first = await enqueue(rt, inst, { kind: "manual" });
    await runOnce();
    const [a] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    expect(a!.stepTitle).toBe("Payment 3");
    expect(a!.question).toBe('Pay 40 USDC to Supplier 3? Today\'s spending would come to 120 USDC, over your daily limit of 100 USDC ("Ask me before a day\'s spending goes over").');
    await answer(rt, owner.id, a!.id, "No");
    await runOnce();
    expect((await jobOf(first.id)).status).toBe("cancelled");
    // Another job the same day: the day's 80 already counts.
    rt.clock.move(60_000);
    const second = await enqueue(rt, inst, { kind: "manual" });
    await runOnce();
    const [b] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    expect(b!.stepTitle).toBe("Payment 1");
    expect(b!.question).toMatch(/Today's spending would come to 120 USDC/);
    await answer(rt, owner.id, b!.id, "No");
    await runOnce();
    expect((await jobOf(second.id)).status).toBe("cancelled");
    // The owner's next day starts afresh.
    rt.clock.move(24 * 3_600_000);
    const third = await enqueue(rt, inst, { kind: "manual" });
    await runOnce();
    const [c] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    expect(c!.stepTitle).toBe("Payment 3");
    expect((await jobOf(third.id)).status).toBe("waiting_for_owner");
  });
});

describe("without limits", () => {
  it("spending goes through without asking", async () => {
    const d = fivePayments();
    const free: AgentDefinition = { ...d, actions: [{ id: "pay", tool: "wallet.pay", description: "Pay a supplier" }] };
    const inst = await paying(await installed(rt, owner, await publishedAgent(db, owner, { definition: free, code: { make: ok(MAKE) } })));
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runOnce();
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    expect(await walletOf(inst.id)).toBe(300);
  });
});
