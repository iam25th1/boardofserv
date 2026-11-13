// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { asc, eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { checkDefinition, type AgentDefinition } from "@/lib/agents/definition";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { FAKE_FORM_LINK, FAKE_TYPEFORM_TOKEN, fakeTypeform } from "@/test/fakeTypeform";
import { keep } from "@/lib/connections/vault";
import type { StepCode } from "@/lib/agents/types";
import { claimJob, enqueue, runJob } from "./jobs";

// An agent that reads its owner's Typeform form with their own token: each
// new response once, every answer under its question's title, a response
// with nothing in it but a name passed by, and nothing ever sent twice.

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

function scorer(): AgentDefinition {
  const c = checkDefinition({
    format: 1,
    name: "Hackathon Submission Scorer",
    job: { does: "Scores each new submission to your Typeform form from 1 to 10 with reasons and sends you the scores.", done: "Every new submission is scored." },
    triggers: [{ kind: "schedule", every: "hours", interval: 1, at: null, description: "Every hour" }],
    settings: [{ key: "form_link", label: "Your Typeform form's link", type: "url", help: "The form people submit to.", choices: [] }],
    rules: [],
    memory: [],
    steps: [
      { id: "read", title: "Read new submissions", kind: "code", inputs: ["settings"], outputs: ["submissions"], description: "Read the form's new responses with typeform.read and return them.", tools: ["typeform.read"], next: "each" },
      { id: "each", title: "Each submission", kind: "loop", inputs: ["submissions"], outputs: ["results"], over: "submissions", item: "submission", body: "score", gather: [{ from: "result", into: "results" }], next: "summary" },
      { id: "score", title: "Score the submission", kind: "code", inputs: ["submission"], outputs: ["result"], description: "Ask SERV with serv.reason to score the submission from 1 to 10 for quality, with answer { score: number, reasons: text }.", tools: ["serv.reason"], next: null },
      { id: "summary", title: "Write the summary", kind: "code", inputs: ["results"], outputs: ["message"], description: "One message naming every submission with its score and reasons.", tools: [], next: "send" },
      { id: "send", title: "Send the scores", kind: "action", action: "send_scores", inputs: ["message"], outputs: [], next: null },
    ],
    actions: [{ id: "send_scores", tool: "telegram.send", description: "Send you the scores" }],
    limits: { maxSteps: 60, maxRunSeconds: 120, maxSpendUsd: 0.2 },
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
}

const CODE = {
  read: ok("async function run(input, tools) { const r = await tools.typeform.read({ form: input.settings.form_link }); return { submissions: r.responses.map((x) => ({ id: x.id, answers: x.answers })) }; }"),
  score: ok(
    "async function run(input, tools) { const a = input.submission.answers; const r = await tools.serv.reason({ task: 'Score this hackathon submission from 1 to 10 for quality.', data: a, answer: { score: 'number', reasons: 'text' } }); return { result: { name: a['Project name'], score: r.score, reasons: r.reasons } }; }",
  ),
  summary: ok("async function run(input) { return { message: { text: input.results.map((r) => '*' + r.name + '*: ' + r.score + '/10. ' + r.reasons).join('\\n') } }; }"),
};

async function ready() {
  await keep(rt, maker.id, "typeform", "Typeform (sample-maker)", { token: FAKE_TYPEFORM_TOKEN });
  const p = await publishedAgent(db, maker, { definition: scorer(), code: CODE });
  return installed(rt, maker, p, { settings: { form_link: FAKE_FORM_LINK } });
}

async function runOnce(inst: schema.AgentInstallation) {
  const job = await enqueue(rt, inst, { kind: "manual" });
  await runJob(rt, (await claimJob(rt, "w"))!, "w");
  rt.clock.move(60_000);
  return (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id)))[0]!;
}

const sent = async (installationId: string) => (await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, installationId)).orderBy(asc(schema.agentMessages.createdAt))).map((m) => m.text);

describe("an agent reading its owner's Typeform form", () => {
  it("scores each submission with something in it, passes by the one that is only a name, and never takes one twice", async () => {
    const form = fakeTypeform(rt.net);
    let n = 0;
    rt.reasonAnswer = (request) => ({ score: request.includes("Tidewatch") ? 9 : request.includes("Shelf Life") ? 8 : request.includes("Something with AI") ? 2 : 5 + (n++ % 2), reasons: "Because of what it has and lacks." });
    const inst = await ready();

    const first = await runOnce(inst);
    expect(first).toMatchObject({ status: "done", outcome: null });
    // SERV scored five; "Moonshot", only a name, was passed by.
    expect(rt.reasoned).toHaveLength(5);
    expect(rt.reasoned.some((r) => r.includes("Moonshot"))).toBe(false);
    // Each answer under its question's title, unanswered ones as null.
    expect(rt.reasoned[0]).toContain('"Project name":"Tidewatch"');
    expect(rt.reasoned[3]).toContain('"Team name":null');
    const [message] = await sent(inst.id);
    expect(message).toContain("*Tidewatch*: 9/10");
    expect(message).not.toContain("Moonshot");
    // The token went in the header to Typeform, and nowhere else.
    expect(form.paths).toContain("/forms/FakeForm01/responses?page_size=200&completed=true&sort=submitted_at,asc");
    const seen = await db.select().from(schema.agentSeenItems).where(eq(schema.agentSeenItems.installationId, inst.id));
    expect(seen.map((s) => `${s.itemId}:${s.state}`).sort()).toEqual(["resp1:done", "resp2:done", "resp3:done", "resp4:done", "resp5:done", "resp6:done"]);

    // Run again: nothing new, nothing judged, nothing sent.
    const second = await runOnce(inst);
    expect(second).toMatchObject({ status: "done", reason: "Nothing new to go through, so nothing was sent." });
    expect(rt.reasoned).toHaveLength(5);
    expect(await sent(inst.id)).toHaveLength(1);

    // A new response comes in: only it is taken.
    form.entries.push({ name: "Late Entry", team: "Night Owls", track: "Reppo", description: "Turns meeting notes into a task list, with a demo.", demo: "https://example.com/late" });
    await runOnce(inst);
    expect(rt.reasoned).toHaveLength(6);
    expect(rt.reasoned[5]).toContain("Late Entry");
  });

  it("lets a job's responses go when it failed without sending anything, so the next run takes them", async () => {
    fakeTypeform(rt.net);
    rt.reasonAnswer = () => "down";
    const inst = await ready();
    // SERV not answering: tried again, then failed, having sent nothing.
    for (let i = 0; i < 3; i++) {
      const job = (await claimJob(rt, "w")) ?? (await (async () => {
        await enqueue(rt, inst, { kind: "manual" });
        return claimJob(rt, "w");
      })());
      await runJob(rt, job!, "w");
      rt.clock.move(15 * 60_000);
    }
    expect(await sent(inst.id)).toEqual([]);
    expect(await db.select().from(schema.agentSeenItems).where(eq(schema.agentSeenItems.installationId, inst.id))).toEqual([]);
  });

  it("says plainly when Typeform isn't connected", async () => {
    fakeTypeform(rt.net);
    const p = await publishedAgent(db, maker, { definition: scorer(), code: CODE });
    const other = await addUser(db, "other");
    const inst = await installed(rt, other, p, { settings: { form_link: FAKE_FORM_LINK } }).catch((e: Error) => e);
    expect(inst).toBeInstanceOf(Error);
    expect((inst as Error).message).toBe("Connect Typeform first, on Connections: this agent needs it.");
  });
});
