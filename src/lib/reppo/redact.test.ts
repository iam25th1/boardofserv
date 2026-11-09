// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { restockBench } from "@/test/agentFixtures";
import { linkConnections, ownSheet, publishedAgent, RESTOCK_CODE, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { install } from "@/lib/agents/runtime/installations";
import { claimJob, enqueue, runJob } from "@/lib/agents/runtime/jobs";
import { jobEvalInput, queueJobEval, renterValues, scrub } from "./redact";

// What Reppo is shown is built only from what is public already and words
// fixed in redact.ts. A job full of a renter's personal data and secrets
// goes through it, and none of it survives.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let renter: schema.User;

// A renter's private world: names, contacts, an address, a wallet, a
// private tab, a supplier's private page.
const PRIVATE = {
  name: "Ingrid Halvorsen",
  email: "ingrid.halvorsen@privatemail.example",
  phone: "+44 7700 900123",
  address: "14 Larch Lane, Hollybrook",
  wallet: "0x4b1d9e2c7f0a3d8b6e5c1f9a2b7d4e8c3f6a93ac",
  tab: "IngridPrivateStock",
  link: "https://suppliers.example/ingrid-private-prices?token=s3cr3t-77",
  note: "Bank PIN 4417, never share",
};

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "redact.maker", "redact_maker");
  renter = await addUser(db, "ingrid.halvorsen@privatemail.example", "ingrid_h");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(eq(schema.agentJobs.status, "queued"));
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
  // The guard quotes everything it was shown, as a careless model might.
  rt.guardVerdict = (request) => ({ verdict: "allow", reason: `Fine. It saw: ${request.slice(0, 2000)}` });
});

async function privateJob() {
  await linkConnections(rt, renter);
  const tabs = restockBench().sheets;
  tabs.Stock = tabs.Stock!.map((r) => ({ ...r, fabric: `${r.fabric} for ${PRIVATE.name}`, contact: `${PRIVATE.email} ${PRIVATE.phone}`, ship_to: PRIVATE.address, note: PRIVATE.note }));
  tabs[PRIVATE.tab] = tabs.Stock;
  tabs.Suppliers = tabs.Suppliers!.map((r) => ({ ...r, pay_to: PRIVATE.wallet, page: PRIVATE.link }));
  const sheet = ownSheet(rt, tabs);
  const p = await publishedAgent(db, maker);
  const inst = await install(rt, {
    ownerUserId: renter.id,
    agent: p.agent,
    version: p.version,
    policy: { autoSpendUsdc: 1000 },
    answers: { settings: { stock_sheet: sheet.answer(PRIVATE.tab), orders_sheet: sheet.answer("Orders"), suppliers_sheet: sheet.answer("Suppliers") }, rules: { approval_over_usdc: "4417" }, timezone: "Europe/Oslo", minGapMinutes: 0 },
  });
  const job = await enqueue(rt, inst, { kind: "manual" });
  await runJob(rt, (await claimJob(rt, "w"))!, "w");
  return { p, inst, job, sheet };
}

describe("what Reppo is shown", () => {
  it("is a summary in words of what the agent is for and what it did", async () => {
    const { job } = await privateJob();
    const row = await queueJobEval(rt, job.id);
    const d = restockDefinition();
    if (process.env.SHOW_INPUT) console.log(row!.input);
    expect(row!.taskType).toBe("action");
    expect(row!.input).toContain(`What the person rents it to do (its published purpose): ${d.job.does}`);
    expect(row!.input).toContain("What started this job: the person, by hand");
    expect(row!.input).toMatch(/1\. "Find low stock" \(works something out\), done/);
    expect(row!.input).toMatch(/"Record the order": .+\(it changes the person's own data\): ran, within the person's own settings; the safety check let it run/);
    expect(row!.input).toContain("How it ended: It finished.");
  });

  it("carries none of the renter's data, ids, links, code or prompts", async () => {
    const { p, inst, job, sheet } = await privateJob();
    const row = await queueJobEval(rt, job.id);
    const input = row!.input;
    const d = restockDefinition();
    const forbidden = [
      ...Object.values(PRIVATE),
      "Ingrid",
      "Halvorsen",
      "4417",
      "Europe/Oslo",
      renter.email!,
      "ingrid_h",
      renter.id,
      maker.id,
      inst.id,
      job.id,
      p.agent.id,
      p.version.id,
      sheet.id,
      "docs.google.com",
      "http",
      // The agent's code and its decisions' prompts.
      ...Object.values(RESTOCK_CODE).map((c) => (c.source ?? "").split("\n").find((l) => l.trim().length > 25)!.trim()),
      ...d.steps.flatMap((s) => (s.kind === "decision" ? [s.prompt.slice(0, 40)] : [])),
      "async function",
      "tools.",
    ];
    for (const bad of forbidden) expect(input.includes(bad), `the input carries ${bad}`).toBe(false);
  });

  it("says where a failed job failed, never the failure's own words", async () => {
    await linkConnections(rt, renter);
    const p = await publishedAgent(db, maker);
    // The private stock tab goes missing from the sheet after setup: the
    // job fails, and its reason may name the tab.
    const tabs = { ...restockBench().sheets, [PRIVATE.tab]: restockBench().sheets.Stock! };
    const sheet = ownSheet(rt, tabs);
    const inst = await install(rt, { ownerUserId: renter.id, agent: p.agent, version: p.version, policy: { autoSpendUsdc: 1000 }, answers: { settings: { stock_sheet: sheet.answer(PRIVATE.tab), orders_sheet: sheet.answer("Orders"), suppliers_sheet: sheet.answer("Suppliers") }, rules: {}, timezone: "UTC", minGapMinutes: 0 } });
    const book = rt.net.sheets.get(sheet.id)!;
    book.tabs = book.tabs.filter((t) => t.title !== PRIVATE.tab);
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    const [j] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
    expect(j!.status).toBe("failed");
    const input = (await queueJobEval(rt, job.id))!.input;
    expect(input).toContain('How it ended: It failed at "Find low stock".');
    expect(input).not.toContain(PRIVATE.tab);
  });

  it("is queued once per job", async () => {
    const { job } = await privateJob();
    expect(await queueJobEval(rt, job.id)).not.toBeNull();
    expect(await queueJobEval(rt, job.id)).toBeNull();
  });

  it("takes out contacts, links, ids, long numbers, handles and the renter's own values, even in the maker's words", () => {
    const text = scrub(`Mail ${PRIVATE.email} or call ${PRIVATE.phone}; see ${PRIVATE.link} and www.private-shop.example/x; pay ${PRIVATE.wallet}; id 1e32b3a1-0000-4000-8000-000000000001; card 4111 1111 1111 1111; ask @ingrid_h about the Larch order`, renterValues({ settings: { shop: "Larch" }, handle: "ingrid_h" }));
    for (const bad of [PRIVATE.email, PRIVATE.phone, "suppliers.example", "private-shop.example", PRIVATE.wallet, "1e32b3a1", "4111", "ingrid_h", "Larch"]) expect(text, bad).not.toContain(bad);
    expect(text).toContain("Mail [left out]");
    // Short or empty values take nothing else out.
    expect(scrub("Ask the shop", renterValues({ settings: { a: "", b: "x", n: 7 } }))).toBe("Ask the shop");
  });

  it("stays in words fixed here, whatever the facts say", () => {
    const d = restockDefinition();
    const input = jobEvalInput({ definition: d, trigger: "<script>", steps: [{ stepId: "nope", status: "ok", outcome: null }], actions: [], status: "cancelled" });
    expect(input).toContain("What started this job: something it watches");
    expect(input).not.toContain("<script>");
    expect(input).toContain("It took no action that changes, sends or spends anything.");
    expect(input).toContain("It was stopped before the end");
  });
});
