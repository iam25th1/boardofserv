// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { restockBench } from "@/test/agentFixtures";
import { installed, publishedAgent, RESTOCK_CODE, restockDefinition, testRuntime } from "@/test/runtimeFixtures";
import type { AgentDefinition } from "../definition";
import { whatChanged } from "../plainView";
import { ControlRefused, installationDTO, loadInstallation, switchVersion } from "./installations";

// The owner's own copy says when a newer version of their agent is ready
// ("Version 2 is ready"), with one line on what changed, and switches to it
// in place, keeping its answers. Live, the running card showed version 1
// with no sign a version 2 existed.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
beforeAll(async () => ({ client, db } = await testDb()));
afterAll(async () => client.close());

const hourly = (d: AgentDefinition): AgentDefinition => ({ ...d, triggers: [{ kind: "schedule", every: "minutes", interval: 60, at: null, description: "Every hour" }] });

describe("what a newer version changed, in one line", () => {
  const d = restockDefinition();
  it("says when it runs first, then its steps, then its setup", () => {
    expect(whatChanged(d, hourly(d))).toMatch(/^It now runs every hour, not /);
    const renamed: AgentDefinition = { ...d, steps: d.steps.map((s) => (s.id === "find_low" ? { ...s, title: "Find fabrics running low" } : s)) };
    expect(whatChanged(d, renamed)).toBe('New or changed: "Find fabrics running low".');
    const asks: AgentDefinition = { ...d, settings: [...d.settings, { key: "shop_name", label: "Your shop's name", type: "text", help: "", choices: [] }] };
    expect(whatChanged(d, asks)).toBe('It asks you for "Your shop\'s name" at setup.');
    expect(whatChanged(d, d)).toBe("Its steps read the same; how they do their work changed.");
  });
});

describe("a newer version of the owner's own agent", () => {
  it("shows on its running card with one line on what changed, and Switch moves it there with its answers", async () => {
    const rt = testRuntime(db);
    const maker = await addUser(db, "newer.maker");
    const p = await publishedAgent(db, maker);
    const mine = await installed(rt, maker, p);
    expect((await installationDTO(rt, (await loadInstallation(rt, mine.id))!)).newer).toBeNull();

    const [v2] = await db
      .insert(schema.agentVersions)
      .values({ agentId: p.agent.id, number: 2, state: "published", publishedAt: new Date(), definition: hourly(restockDefinition()), code: RESTOCK_CODE, bench: restockBench() })
      .returning();
    const before = await installationDTO(rt, (await loadInstallation(rt, mine.id))!);
    expect(before.version).toBe(1);
    expect(before.newer).toEqual({ version: 2, line: expect.stringMatching(/^It now runs every hour, not /), breaking: null });

    await switchVersion(rt, (await loadInstallation(rt, mine.id))!);
    const after = await installationDTO(rt, (await loadInstallation(rt, mine.id))!);
    expect(after).toMatchObject({ version: 2, newer: null, settings: before.settings });
    expect(after.runs).toEqual(["Runs every hour"]);
    const triggers = await db.select().from(schema.agentTriggers).where(eq(schema.agentTriggers.installationId, mine.id));
    expect(triggers.map((t) => t.kind)).toEqual(["schedule"]);
    expect(v2!.number).toBe(2);
    await expect(switchVersion(rt, (await loadInstallation(rt, mine.id))!)).rejects.toThrow(new ControlRefused("It runs the newest version already."));
  });

  it("asking something new at setup, is set up from its page rather than switched", async () => {
    const rt = testRuntime(db);
    const maker = await addUser(db, "newer.breaking");
    const p = await publishedAgent(db, maker);
    const mine = await installed(rt, maker, p);
    const asks: AgentDefinition = { ...restockDefinition(), settings: [...restockDefinition().settings, { key: "shop_name", label: "Your shop's name", type: "text", help: "", choices: [] }] };
    await db.insert(schema.agentVersions).values({ agentId: p.agent.id, number: 2, state: "published", publishedAt: new Date(), definition: asks, code: RESTOCK_CODE, bench: restockBench() });
    const dto = await installationDTO(rt, (await loadInstallation(rt, mine.id))!);
    expect(dto.newer).toEqual({ version: 2, line: 'It asks you for "Your shop\'s name" at setup.', breaking: 'It asks something new at setup ("Your shop\'s name").' });
    await expect(switchVersion(rt, (await loadInstallation(rt, mine.id))!)).rejects.toThrow('It asks something new at setup ("Your shop\'s name"). Set version 2 up from its page.');
  });

  it("isn't offered on a renter's copy (Rented offers it) or a draft", async () => {
    const rt = testRuntime(db);
    const maker = await addUser(db, "newer.draft");
    const renter = await addUser(db, "newer.renter");
    const p = await publishedAgent(db, maker);
    const theirs = await installed(rt, renter, p);
    const mine = await installed(rt, maker, p);
    await db.insert(schema.agentVersions).values({ agentId: p.agent.id, number: 2, state: "draft", definition: hourly(restockDefinition()), code: RESTOCK_CODE, bench: restockBench() });
    expect((await installationDTO(rt, (await loadInstallation(rt, mine.id))!)).newer).toBeNull();
    await db.insert(schema.agentVersions).values({ agentId: p.agent.id, number: 3, state: "published", publishedAt: new Date(), definition: hourly(restockDefinition()), code: RESTOCK_CODE, bench: restockBench() });
    expect((await installationDTO(rt, (await loadInstallation(rt, theirs.id))!)).newer).toBeNull();
    expect((await installationDTO(rt, (await loadInstallation(rt, mine.id))!)).newer).toMatchObject({ version: 3 });
  });
});
