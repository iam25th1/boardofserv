// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { asc, eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { checkDefinition, type AgentDefinition } from "@/lib/agents/definition";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { jobWhy } from "@/lib/agents/plainWords";
import { emptyBench, type StepCode, type TestResult } from "@/lib/agents/types";
import { cancelJob, claimJob, enqueue, handTrigger, runJob } from "./jobs";
import { jobsOfInstallation } from "./views";

// How a job ends when it isn't plainly done: skipped when a step that
// judges or writes has nothing to work on (nothing is sent), and done with
// a note when only a side step didn't go through. The live Hackathon
// Submission Scorer was marked failed after its assessment went out,
// because "Update scoring memory" was blocked; and it scored and sent a
// Typeform link it had read nothing from.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "maker");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"]));
  rt = testRuntime(db);
});

const ok = (source: string): StepCode => ({ spec: "", status: "approved", source, rounds: 1, note: null, updatedAt: "" });
const jobOf = async (id: string) => (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, id)))[0]!;
const sentTo = async (installationId: string) => (await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, installationId)).orderBy(asc(schema.agentMessages.createdAt))).map((m) => m.text);

// A submission scorer that runs on a message: SERV scores what came in,
// it sends the score, then notes it for next time.
function scorer(): AgentDefinition {
  const c = checkDefinition({
    format: 1,
    name: "Hackathon Submission Scorer",
    job: { does: "Scores each submission it is sent from 1 to 10 for quality and sends you the score with reasons.", done: "The submission has a score." },
    triggers: [{ kind: "message", from: "telegram", description: "When a submission comes in" }],
    settings: [],
    rules: [],
    memory: [{ key: "last_score", description: "The last score it gave", type: "number" }],
    steps: [
      { id: "read", title: "Read the submission", kind: "code", inputs: ["trigger"], outputs: ["submission"], description: "Return submission { text } from trigger.text.", tools: [], next: "score" },
      {
        id: "score",
        title: "Score submission quality",
        kind: "code",
        inputs: ["submission"],
        outputs: ["assessment"],
        description: "Ask SERV with serv.reason to score the submission from 1 to 10 for quality, with answer { score: number, reasons: text }. Return assessment { score, reasons }.",
        tools: ["serv.reason"],
        next: "make",
      },
      { id: "make", title: "Write the message", kind: "code", inputs: ["assessment"], outputs: ["message"], description: "Return message { text } with the score and reasons.", tools: [], next: "send" },
      { id: "send", title: "Send the assessment", kind: "action", action: "send_assessment", inputs: ["message"], outputs: [], next: "note" },
      { id: "note", title: "Make the note", kind: "code", inputs: ["assessment"], outputs: ["remember"], description: "Return remember as memory.set's arguments: the key last score, and the assessment's score.", tools: [], next: "save" },
      { id: "save", title: "Update scoring memory", kind: "action", action: "save_score", inputs: ["remember"], outputs: [], next: null },
    ],
    actions: [
      { id: "send_assessment", tool: "telegram.send", description: "Send you the assessment" },
      { id: "save_score", tool: "memory.set", description: "Remember the last score" },
    ],
    limits: { maxSteps: 10, maxRunSeconds: 60, maxSpendUsd: 0.2 },
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
}

const CODE = {
  read: ok("async function run(input) { return { submission: { text: (input.trigger && input.trigger.text) || '' } }; }"),
  score: ok(
    "async function run(input, tools) { const r = await tools.serv.reason({ task: 'Score this submission from 1 to 10 for quality.', data: input.submission, answer: { score: 'number', reasons: 'text' } }); return { assessment: { score: r.score, reasons: r.reasons } }; }",
  ),
  make: ok("async function run(input) { return { message: { text: 'Score: ' + input.assessment.score + '/10. ' + input.assessment.reasons } }; }"),
  note: ok("async function run(input) { return { remember: { key: 'last_score', value: input.assessment.score } }; }"),
};

async function ready(o: { testResult?: TestResult | null } = {}) {
  const p = await publishedAgent(db, maker, { definition: scorer(), code: CODE });
  if (o.testResult !== undefined) await db.update(schema.agentVersions).set({ testResult: o.testResult }).where(eq(schema.agentVersions.id, p.version.id));
  return installed(rt, maker, p, { settings: {} });
}

async function runOnce(inst: schema.AgentInstallation, trigger: Record<string, unknown> & { kind: "manual" | "message" }) {
  const job = await enqueue(rt, inst, trigger);
  await runJob(rt, (await claimJob(rt, "w"))!, "w");
  return jobOf(job.id);
}

describe("a job whose side step is stopped", () => {
  it("is done, with a note, once what it was for is done: the assessment went out", async () => {
    rt.guardVerdict = (request) => (request.includes("memory.set") ? { verdict: "block", reason: "Remembering scores is outside what this agent is for." } : { verdict: "allow", reason: "It fits." });
    const inst = await ready();
    const job = await runOnce(inst, { kind: "message", text: "Tide: a tide-pool tracker with a public demo and a README." });
    expect(job.status).toBe("done");
    expect(job.outcome).toBe("noted");
    expect(job.reason).toBe('Done, with a note: "Update scoring memory" was stopped by the safety check: Remembering scores is outside what this agent is for. Everything else it was for was done.');
    expect(await sentTo(inst.id)).toEqual(["Score: 7/10. SERV's reasons."]);
    const [card] = await jobsOfInstallation(rt, inst.id, 1);
    expect(card).toMatchObject({ status: "done", outcome: "noted", why: job.reason });
  });

  it("asks its maker in the chat it was made in, once, whether to take the step out", async () => {
    rt.guardVerdict = (request) => (request.includes("memory.set") ? { verdict: "block", reason: "Remembering scores is outside what this agent is for." } : { verdict: "allow", reason: "It fits." });
    const inst = await ready();
    const [convo] = await db.insert(schema.conversations).values({ userId: maker.id, title: "Scorer" }).returning();
    await db.update(schema.agents).set({ sourceConversationId: convo!.id }).where(eq(schema.agents.id, inst.agentId));
    await runOnce(inst, { kind: "message", text: "Tide" });
    rt.clock.move(60_000);
    await runOnce(inst, { kind: "message", text: "Notes" });
    const said = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, convo!.id));
    expect(said.map((m) => `${m.role}: ${m.content}`)).toEqual([
      'assistant: When it ran, the safety check stopped "Update scoring memory": Remembering scores is outside what this agent is for. Should I take that step out? Say "take it out", or tell me why it belongs and I\'ll change the steps.',
    ]);
  });

  it("never asks the maker about a renter's run: what a renter's job saw is theirs", async () => {
    rt.guardVerdict = (request) => (request.includes("memory.set") ? { verdict: "block", reason: "Outside its purpose." } : { verdict: "allow", reason: "It fits." });
    const p = await publishedAgent(db, maker, { definition: scorer(), code: CODE });
    const [convo] = await db.insert(schema.conversations).values({ userId: maker.id, title: "Scorer" }).returning();
    await db.update(schema.agents).set({ sourceConversationId: convo!.id }).where(eq(schema.agents.id, p.agent.id));
    const renter = await addUser(db, "renter");
    const inst = await installed(rt, renter, p, { settings: {} });
    await runOnce(inst, { kind: "message", text: "Tide" });
    expect(await db.select().from(schema.messages).where(eq(schema.messages.conversationId, convo!.id))).toEqual([]);
  });

  it("still fails when what it stopped is the job itself", async () => {
    rt.guardVerdict = (request) => (request.includes("telegram.send") ? { verdict: "block", reason: "It sends something odd." } : { verdict: "allow", reason: "It fits." });
    const inst = await ready();
    const job = await runOnce(inst, { kind: "message", text: "Tide" });
    expect(job).toMatchObject({ status: "failed", outcome: null });
    expect(job.reason).toBe('"Send the assessment" was stopped by the safety check: It sends something odd.');
  });
});

describe("a job with nothing to work on", () => {
  it("is skipped, empty input, and sends nothing: a hand run with no message and no sample", async () => {
    const inst = await ready({ testResult: null });
    const job = await runOnce(inst, { kind: "manual" });
    expect(job).toMatchObject({ status: "done", outcome: "skipped" });
    expect(job.reason).toBe('Skipped, empty input: "Score submission quality" had nothing to work on (submission was empty), so nothing was sent.');
    expect(rt.reasoned).toEqual([]);
    expect(await sentTo(inst.id)).toEqual([]);
    const [card] = await jobsOfInstallation(rt, inst.id, 1);
    expect(card).toMatchObject({ outcome: "skipped", why: job.reason });
  });

  it("runs by hand on the sample its test ran on, when nothing live woke it", async () => {
    const sample = { ...emptyBench(), trigger: { text: "Notes: an app for notes." } };
    const tested: TestResult = { status: "passed", story: "", problems: [], items: null, kind: "self", checkedAt: "2026-11-09T05:00:00.000Z", sample };
    const inst = await ready({ testResult: tested });
    const job = await runOnce(inst, { kind: "manual" });
    expect(job.status).toBe("done");
    expect(rt.reasoned).toHaveLength(1);
    expect(rt.reasoned[0]).toContain("Notes: an app for notes.");
    expect(await sentTo(inst.id)).toEqual(["Score: 7/10. SERV's reasons."]);
    expect(job.state?.bag.trigger).toEqual({ text: "Notes: an app for notes.", kind: "manual", sample: true });
  });

  it("keeps what woke a run, and leaves a schedule's run alone", () => {
    const d = scorer();
    const sample = { ...emptyBench(), trigger: { text: "x" } };
    expect(handTrigger(d, { kind: "message", text: "real" }, sample)).toEqual({ kind: "message", text: "real" });
    expect(handTrigger(d, { kind: "manual", text: "given" }, sample)).toEqual({ kind: "manual", text: "given" });
    expect(handTrigger({ ...d, triggers: [{ kind: "schedule", every: "day", at: "08:00", description: "Every day" }] }, { kind: "manual" }, sample)).toEqual({ kind: "manual" });
  });
});

describe("why a job ended, on its card", () => {
  it("is one plain sentence", () => {
    expect(jobWhy({ status: "failed", reason: '"Read the submission" failed: TypeError: cannot read property \'text\' of undefined' })).toBe('"Read the submission" stopped on a mistake in its code.');
    expect(jobWhy({ status: "failed", reason: "It reached its limit of 10 steps." })).toBe("It reached its limit of 10 steps.");
    expect(jobWhy({ status: "done", reason: "It reached the end of its steps." })).toBeNull();
    expect(jobWhy({ status: "running", reason: null })).toBeNull();
  });
});

describe("Cancel", () => {
  it("ends a job that hasn't started", async () => {
    const inst = await ready();
    const job = await enqueue(rt, inst, { kind: "message", text: "Tide" });
    await cancelJob(rt, maker.id, job.id);
    expect(await jobOf(job.id)).toMatchObject({ status: "cancelled", reason: "Cancelled by its owner." });
    expect(await claimJob(rt, "w")).toBeNull();
  });

  it("stops a running job where it is: its call to SERV aborted, nothing sent", async () => {
    const inst = await ready();
    const fetch = rt.fetchImpl!;
    let waiting: (() => void) | null = null;
    const reached = new Promise<void>((r) => (waiting = r));
    rt.fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { response_format?: { json_schema?: { name?: string } } };
      if (body.response_format?.json_schema?.name !== "reasoning") return fetch(url, init);
      waiting?.();
      return new Promise<Response>((_r, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    }) as typeof fetch;
    const job = await enqueue(rt, inst, { kind: "message", text: "Tide" });
    const running = runJob(rt, (await claimJob(rt, "w"))!, "w");
    await reached;
    await cancelJob(rt, maker.id, job.id);
    await running;
    expect(await jobOf(job.id)).toMatchObject({ status: "cancelled", reason: "Cancelled by its owner." });
    expect(await sentTo(inst.id)).toEqual([]);
  });

  it("is only for the job's owner, and not once it has finished", async () => {
    const inst = await ready();
    const job = await enqueue(rt, inst, { kind: "message", text: "Tide" });
    const someone = await addUser(db, "someone");
    await expect(cancelJob(rt, someone.id, job.id)).rejects.toThrow("Not found");
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    await expect(cancelJob(rt, maker.id, job.id)).rejects.toThrow("It has finished already.");
  });
});

