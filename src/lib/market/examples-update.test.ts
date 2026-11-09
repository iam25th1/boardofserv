// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import lead from "@/lib/agents/examples/lead-followup.json";
import { vetVersion } from "@/lib/agents/publish";
import { offerVersion } from "./versions";
import { screenListing } from "@/lib/safety/moderation";
import { importExample, updateExample, type SavedExample } from "./examples";
import { agentPage } from "./listings";
import { rent } from "./rentals";

// The import's update option: an example already on the board from an
// older saved file gets a new version through the normal path (the code
// review, published, the board moved to it, renters offered it, the
// listing screened again). Without changes it is left alone; anything the
// path refuses leaves the board as it was.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let renter: schema.User;
const path = { vet: vetVersion, offer: offerVersion, screen: screenListing };

// The enquiry follow-up as an older file had it: a fixed daily schedule.
const older = (): SavedExample => {
  const s = structuredClone(lead) as unknown as SavedExample & { definition: { triggers: unknown[] } };
  s.definition.triggers = [{ kind: "schedule", every: "day", interval: null, at: "09:00", description: "Every morning, check for new enquiries" }];
  return s;
};

beforeAll(async () => {
  ({ client, db } = await testDb());
  renter = await addUser(db, "update.renter", "update_renter");
});
afterAll(async () => client.close());
beforeEach(() => {
  rt = testRuntime(db);
});

async function onBoardFromOlder() {
  const admin = await addUser(db, `update.admin.${Math.random()}`, `admin_${Math.floor(Math.random() * 1e6)}`);
  const made = await importExample(rt, admin, older());
  return { admin, agentId: made.agentId };
}

const versionsOf = async (agentId: string) => db.select().from(schema.agentVersions).where(eq(schema.agentVersions.agentId, agentId));

describe("updating the examples", () => {
  it("publishes the saved plan as a new version, moves the board to it and its renters with it", async () => {
    const { admin, agentId } = await onBoardFromOlder();
    expect((await agentPage(rt, agentId))!.runs).toEqual(["Runs every day at 9:00"]);
    const rental = await rent(rt, { renterUserId: renter.id, agentId });
    const got = await updateExample(rt, admin, lead as unknown as SavedExample, path);
    expect(got).toMatchObject({ outcome: "updated", version: 2 });
    const page = (await agentPage(rt, agentId))!;
    expect(page.version).toBe(2);
    expect(page.runs).toEqual(["Runs every 15 minutes"]);
    const v2 = (await versionsOf(agentId)).find((v) => v.number === 2)!;
    expect(v2).toMatchObject({ state: "published" });
    expect(v2.review).toMatchObject({ status: "passed", by: "serv" });
    // A rental not set up yet moves with it; the listing was screened again.
    expect((await db.select().from(schema.rentals).where(eq(schema.rentals.id, rental.id)))[0]!.versionId).toBe(v2.id);
    expect(rt.posts.length).toBeGreaterThan(0);
    // Again: nothing to do.
    expect(await updateExample(rt, admin, lead as unknown as SavedExample, path)).toMatchObject({ outcome: "up to date" });
    expect(await versionsOf(agentId)).toHaveLength(2);
  });

  it("puts an example that isn't there on the board", async () => {
    const admin = await addUser(db, "update.fresh", "update_fresh");
    const got = await updateExample(rt, admin, lead as unknown as SavedExample, path);
    expect(got.outcome).toBe("created");
    expect((await agentPage(rt, got.agentId))!.runs).toEqual(["Runs every 15 minutes"]);
  });

  it("leaves the board as it was when the review blocks it or can't run, or a draft is in the way", async () => {
    const { admin, agentId } = await onBoardFromOlder();
    rt.reviewFindings = () => [{ step: "the agent", severity: "blocking", finding: "It sends the enquiries somewhere its purpose doesn't need." }];
    const blocked = await updateExample(rt, admin, lead as unknown as SavedExample, path);
    expect(blocked).toMatchObject({ outcome: "refused", why: "the code review found problems: It sends the enquiries somewhere its purpose doesn't need." });
    expect((await agentPage(rt, agentId))!.version).toBe(1);
    // The refused draft stays for its maker to see; the next run says so.
    expect(await updateExample(rt, admin, lead as unknown as SavedExample, path)).toMatchObject({ outcome: "refused", why: expect.stringContaining("has a draft") });
    await db.delete(schema.agentVersions).where(and(eq(schema.agentVersions.agentId, agentId), eq(schema.agentVersions.state, "draft")));
    rt.reviewFindings = () => "down";
    expect(await updateExample(rt, admin, lead as unknown as SavedExample, path)).toMatchObject({ outcome: "refused", why: expect.stringContaining("couldn't run") });
    expect((await agentPage(rt, agentId))!.runs).toEqual(["Runs every day at 9:00"]);
  });
});
