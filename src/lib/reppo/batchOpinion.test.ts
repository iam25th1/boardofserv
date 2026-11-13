// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { checkDefinition } from "@/lib/agents/definition";
import type { StepCode } from "@/lib/agents/types";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { fakeReppo, type FakeReppo } from "@/test/fakeReppo";
import { answer, approvalsOf } from "@/lib/agents/runtime/approvals";
import { claimJob, enqueue, runJob } from "@/lib/agents/runtime/jobs";
import { messagesOf } from "@/lib/agents/runtime/messages";
import { deliverTelegram, resetTelegramHolds } from "@/lib/telegram/deliver";
import { reppoCycle } from "./cycle";
import { linkFacts, oneLine, riskyLabels } from "./batch";

// Reppo's second opinion on the one question about a run's held messages:
// one redacted evaluation for the whole batch (each link a label and what
// can be told of it, never the link or the words), its score, route and
// one-line reason on the card and in Telegram, and each link it calls risky
// flagged on its message. It never decides and never holds anything up:
// slow, capped or down, the question goes at once with "Reppo: not
// checked", and the owner's answer alone decides.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let reppo: FakeReppo;
let owner: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "batch.owner", "batch_owner");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentApprovals).set({ status: "cancelled" }).where(eq(schema.agentApprovals.status, "pending"));
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"]));
  rt = testRuntime(db);
  reppo = fakeReppo(rt.net);
  reppo.readsToFinish = 1;
  resetTelegramHolds();
});
afterEach(() => vi.unstubAllEnvs());

const ok = (source: string): StepCode => ({ spec: "", status: "approved", source, rounds: 1, note: null, updatedAt: "" });

// Five messages, each with a link the owner never gave; the third's is a
// shortened plain-http link with "claim" in it.
const LINKS = ["https://tidewatch.example/demo", "https://shelf-life.example/demo", "http://bit.ly/claim-prize", "https://recipe-remix.example/demo", "https://lantern.example/demo"];
const NAMES = ["Tidewatch", "Shelf Life", "Prize Corner", "Recipe Remix", "Lantern"];

function sender() {
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
      { id: "each", title: "Each project", kind: "loop", inputs: ["projects"], outputs: [], over: "projects", item: "project", body: "write", gather: [], next: null },
      { id: "write", title: "Write the message", kind: "code", inputs: ["project"], outputs: ["message"], description: "Return message as telegram.send's arguments { text } naming the project and its demo link.", tools: [], next: "send" },
      { id: "send", title: "Send the link", kind: "action", action: "send_link", inputs: ["message"], outputs: [], next: null },
    ],
    actions: [{ id: "send_link", tool: "telegram.send", description: "Send you the demo link" }],
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return {
    definition: c.definition,
    code: {
      make: ok(`async function run() { return { projects: ${JSON.stringify(NAMES.map((name, i) => ({ name, demo: LINKS[i] })))} }; }`),
      write: ok("async function run(input) { return { message: { text: input.project.name + ': try the demo at ' + input.project.demo } }; }"),
    },
  };
}

async function runOnce() {
  const job = await claimJob(rt, "w");
  if (job) await runJob(rt, job, "w");
}
const jobOf = async (id: string) => (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, id)))[0]!;
const said = async (installationId: string) => (await messagesOf(rt, installationId)).filter((m) => m.from === "agent").map((m) => m.text);
const asksIn = (texts: string[]) => texts.filter((t) => t.includes(", asks:"));

async function waiting() {
  const inst = await installed(rt, owner, await publishedAgent(db, owner, sender()));
  const job = await enqueue(rt, inst, { kind: "manual" });
  await runOnce();
  const [a] = await approvalsOf(rt, owner.id, { jobId: job.id, pendingOnly: true });
  return { inst, job, a: a! };
}

// Reppo's cycle until the opinion is back.
async function opinionBack() {
  await reppoCycle(rt);
  rt.clock.move(31_000);
  await reppoCycle(rt);
}

describe("Reppo on the one question about a run's messages", () => {
  it("is one evaluation for the batch, from labels and facts, never the links or the words", async () => {
    const { a } = await waiting();
    const rows = await db.select().from(schema.reppoEvals).where(eq(schema.reppoEvals.approvalId, a.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "action", taskType: "action", status: "queued" });
    const input = rows[0]!.input;
    for (let i = 1; i <= 5; i++) expect(input).toContain(`Message ${i}: L${i} (`);
    expect(input).toContain("L3 (a web link: plain http, not https; a link shortener that hides where it goes; words like login, verify, claim or wallet in it)");
    expect(input).toContain('"Risky links: L2, L5."');
    for (const bad of [...LINKS, ...NAMES, "bit.ly", ".example", "try the demo", owner.id]) expect(input, bad).not.toContain(bad);
    await opinionBack();
    // One call to Reppo for all five.
    expect(reppo.submitted).toHaveLength(1);
    // It counts once against the day's credits, like any other evaluation.
    expect(await db.select().from(schema.reppoEvals).where(eq(schema.reppoEvals.kind, "action"))).toHaveLength(1);
  });

  it("shows its score, route and one-line reason on the card and in Telegram, and flags each risky link on its message", async () => {
    reppo.verdict = () => ({ score: 41, route: "review", reason: "Risky links: L3. A shortened plain http link asking to claim something is a common lure. The other four look like ordinary demo pages." });
    const { a } = await waiting();
    // The question goes to Telegram at once, before Reppo is back.
    await deliverTelegram(rt);
    const first = asksIn(rt.net.telegram("sendMessage").map((m) => String(m.text)));
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("Reppo: not checked yet.");
    await opinionBack();
    const [shown] = await approvalsOf(rt, owner.id, { jobId: a.jobId });
    expect(shown!.opinion).toMatchObject({ state: "ready", score: 41, route: "review", reason: "A shortened plain http link asking to claim something is a common lure." });
    expect(shown!.items!.map((m) => m.links.map((l) => l.risky))).toEqual([[false], [false], [true], [false], [false]]);
    expect(shown!.items![2]).toMatchObject({ text: `Prize Corner: try the demo at ${LINKS[2]}`, links: [{ link: LINKS[2], risky: true }] });
    // The Telegram question is brought up to date in place, buttons kept.
    await deliverTelegram(rt);
    const edited = rt.net.telegram("editMessageText");
    expect(edited).toHaveLength(1);
    const text = String(edited[0]!.text);
    expect(text).toContain("Reppo: 41 out of 100, it suggests a closer look. A shortened plain http link asking to claim something is a common lure.");
    expect(text).toContain(`${LINKS[2]} (Reppo calls this risky)`);
    expect(text).not.toContain(`${LINKS[0]} (Reppo calls this risky)`);
    expect(edited[0]!.reply_markup).toBeTruthy();
    // No separate note in the message box: the question carries it.
    expect((await said(a.installationId)).some((t) => t.startsWith("Second opinion"))).toBe(false);
  });

  it("goes at once with Reppo: not checked when Reppo is capped or off, and the owner's yes still sends them all", async () => {
    vi.stubEnv("REPPO_DAILY_CREDITS", "0");
    const { inst, job, a } = await waiting();
    expect(await db.select().from(schema.reppoEvals).where(eq(schema.reppoEvals.approvalId, a.id))).toEqual([]);
    expect(a.opinion).toMatchObject({ state: "none" });
    await deliverTelegram(rt);
    const [asked] = asksIn(rt.net.telegram("sendMessage").map((m) => String(m.text)));
    expect(asked).toContain("Reppo: not checked.");
    await answer(rt, owner.id, a.id, "Yes to all");
    await runOnce();
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    expect(await said(inst.id)).toHaveLength(5);
  });

  it("goes at once when Reppo is down, says not checked once it gives up, and the owner's no still sends none", async () => {
    reppo.down = true;
    const { inst, job, a } = await waiting();
    await deliverTelegram(rt);
    expect(asksIn(rt.net.telegram("sendMessage").map((m) => String(m.text)))[0]).toContain("Reppo: not checked yet.");
    for (let i = 0; i < 6; i++) {
      await reppoCycle(rt, { call: { sleep: async () => undefined } });
      rt.clock.move(2 * 60 * 60_000);
    }
    const [shown] = await approvalsOf(rt, owner.id, { jobId: job.id });
    expect(shown).toMatchObject({ status: "pending", opinion: { state: "none" } });
    await answer(rt, owner.id, a.id, "No to all");
    await runOnce();
    expect(await jobOf(job.id)).toMatchObject({ status: "done" });
    expect(await said(inst.id)).toEqual([]);
  });

  it("decides nothing: advising against them, the owner's yes sends them; liking them, the owner's no sends none", async () => {
    reppo.verdict = () => ({ score: 12, route: "block", reason: "Risky links: L1, L2, L3, L4, L5. None of these should be trusted." });
    const one = await waiting();
    await opinionBack();
    expect((await jobOf(one.job.id)).status).toBe("waiting_for_owner");
    await answer(rt, owner.id, one.a.id, "Yes to all");
    await runOnce();
    expect(await said(one.inst.id)).toHaveLength(5);

    reppo.verdict = () => ({ score: 95, route: "ship", reason: "Risky links: none. Ordinary demo pages." });
    const two = await waiting();
    await opinionBack();
    expect((await jobOf(two.job.id)).status).toBe("waiting_for_owner");
    await answer(rt, owner.id, two.a.id, "No to all");
    await runOnce();
    expect(await jobOf(two.job.id)).toMatchObject({ status: "done" });
    expect(await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.jobId, two.job.id))).toEqual([]);
  });

  it("carries its flags into Pick one by one", async () => {
    reppo.verdict = () => ({ score: 41, route: "review", reason: "Risky links: L3. A common lure." });
    const { job, a } = await waiting();
    await opinionBack();
    await answer(rt, owner.id, a.id, "Pick one by one");
    await runOnce();
    const each = await approvalsOf(rt, owner.id, { jobId: job.id, pendingOnly: true });
    expect(each).toHaveLength(5);
    const flagged = each.filter((x) => x.items?.[0]?.links.some((l) => l.risky));
    expect(flagged.map((x) => x.items![0]!.text)).toEqual([`Prize Corner: try the demo at ${LINKS[2]}`]);
  });
});

describe("what Reppo is told of a link, and what it says back", () => {
  it("tells a link's shape without the link", () => {
    expect(linkFacts("https://lantern.example/demo")).toBe("a web link: an ordinary web address");
    expect(linkFacts("http://192.168.4.20:8080/login")).toBe("a web link: plain http, not https; a bare IP address instead of a name; an unusual port; words like login, verify, claim or wallet in it");
    expect(linkFacts("https://xn--pple-43d.top/verify")).toBe("a web link: a look-alike (punycode) name; a top-level domain often used for spam; words like login, verify, claim or wallet in it");
    expect(linkFacts("help@mill.example")).toBe("an email address");
    expect(linkFacts("0x52908400098527886E0F7030069857D2E4169EE7")).toBe("a wallet address");
    expect(linkFacts("+1 415 555 0134")).toBe("a phone number");
  });

  it("reads which links it calls risky, and its reason in one line", () => {
    expect(riskyLabels("Risky links: L2, L5. They hide where they go.")).toEqual(["L2", "L5"]);
    expect(riskyLabels("Risky links: none. All fine.")).toEqual([]);
    expect(riskyLabels("L1 looks fine.")).toEqual([]);
    expect(oneLine("Risky links: L2. A shortened link is a common lure. The rest look fine.")).toBe("A shortened link is a common lure.");
    expect(oneLine(null)).toBeNull();
  });
});
