// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { restockBench } from "@/test/agentFixtures";
import { installed, ownSheet, publishedAgent, RESTOCK_CODE, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import type { AgentDefinition } from "../definition";
import { installationDTO, loadInstallation, ownCopies, runOwnCopy, stopOtherCopies } from "./installations";

// The owner's own agent runs as one copy: Run it for real (and Run it for
// me) takes over the copy running now, keeping what it remembers, never
// adding a second one beside it. Copies from before are offered to stop.
// Live, an owner ended up with two copies of one checker, each sending the
// same message.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
beforeAll(async () => ({ client, db } = await testDb()));
afterAll(async () => client.close());

const hourly = (d: AgentDefinition): AgentDefinition => ({ ...d, triggers: [{ kind: "schedule", every: "minutes", interval: 60, at: null, description: "Every hour" }] });

const answersFor = (rt: TestRuntime) => {
  const sheet = ownSheet(rt);
  return { settings: { stock_sheet: sheet.answer("Stock"), orders_sheet: sheet.answer("Orders"), suppliers_sheet: sheet.answer("Suppliers") }, rules: {}, timezone: "Europe/London" };
};

describe("one running copy of the owner's own agent", () => {
  it("takes over the copy running now with the new version and answers, keeping what it remembers", async () => {
    const rt = testRuntime(db);
    const maker = await addUser(db, "one.copy");
    const p = await publishedAgent(db, maker);
    const first = await installed(rt, maker, p);
    // What it remembers between runs (its place in what it reads).
    await db.update(schema.agentInstallations).set({ memory: { last_order: "PO-7" } }).where(eq(schema.agentInstallations.id, first.id));
    const [v2] = await db
      .insert(schema.agentVersions)
      .values({ agentId: p.agent.id, number: 2, state: "published", publishedAt: new Date(), definition: hourly(restockDefinition()), code: RESTOCK_CODE, bench: restockBench() })
      .returning();

    const again = await runOwnCopy(rt, { ownerUserId: maker.id, agent: p.agent, version: v2!, answers: answersFor(rt), live: true });
    expect(again.replaced).toBe(true);
    expect(again.installation.id).toBe(first.id);
    const copies = await ownCopies(rt, maker.id, p.agent.id);
    expect(copies.map((c) => c.id)).toEqual([first.id]);
    const dto = await installationDTO(rt, (await loadInstallation(rt, first.id))!);
    expect(dto).toMatchObject({ version: 2, timezone: "Europe/London", others: 0, memory: [expect.objectContaining({ key: "last_order", value: "PO-7" })] });
    // Its policy, set when it was first run, stays.
    expect(again.installation.policy).toEqual(first.policy);
    const triggers = await db.select().from(schema.agentTriggers).where(eq(schema.agentTriggers.installationId, first.id));
    expect(triggers.map((t) => t.kind)).toEqual(["schedule"]);
  });

  it("adds a copy only when none runs: a stopped one stays stopped", async () => {
    const rt = testRuntime(db);
    const maker = await addUser(db, "one.copy.stopped");
    const p = await publishedAgent(db, maker);
    const first = await installed(rt, maker, p);
    await db.update(schema.agentInstallations).set({ status: "stopped", stoppedAt: new Date() }).where(eq(schema.agentInstallations.id, first.id));
    const next = await runOwnCopy(rt, { ownerUserId: maker.id, agent: p.agent, version: p.version, answers: answersFor(rt) });
    expect(next.replaced).toBe(false);
    expect(next.installation.id).not.toBe(first.id);
    expect((await ownCopies(rt, maker.id, p.agent.id)).map((c) => c.id)).toEqual([next.installation.id]);
  });

  it("offers to stop the copies running beside one, and stops them, keeping that one", async () => {
    const rt = testRuntime(db);
    const maker = await addUser(db, "one.copy.dupes");
    const p = await publishedAgent(db, maker);
    // Two copies from before: Run it for real added one each time.
    const older = await installed(rt, maker, p);
    const newer = await installed(rt, maker, p);
    const dto = await installationDTO(rt, (await loadInstallation(rt, newer.id))!);
    expect(dto.others).toBe(1);
    expect(await stopOtherCopies(rt, (await loadInstallation(rt, newer.id))!)).toBe(1);
    const [gone] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, older.id));
    expect(gone!.status).toBe("stopped");
    expect((await installationDTO(rt, (await loadInstallation(rt, newer.id))!)).others).toBe(0);
    expect((await installationDTO(rt, (await loadInstallation(rt, older.id))!)).others).toBe(0);
  });

  it("never counts or takes over a renter's copy", async () => {
    const rt = testRuntime(db);
    const maker = await addUser(db, "one.copy.maker");
    const renter = await addUser(db, "one.copy.renter");
    const p = await publishedAgent(db, maker);
    const theirs = await installed(rt, renter, p);
    expect(await ownCopies(rt, renter.id, p.agent.id)).toEqual([]);
    const mine = await installed(rt, maker, p);
    expect((await installationDTO(rt, (await loadInstallation(rt, mine.id))!)).others).toBe(0);
    expect((await installationDTO(rt, (await loadInstallation(rt, theirs.id))!)).others).toBe(0);
  });
});
