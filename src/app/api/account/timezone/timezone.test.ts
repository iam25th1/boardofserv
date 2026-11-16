// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { buildContext } from "@/lib/agents/context";
import { publishedAgent } from "@/test/runtimeFixtures";
import { PUT } from "./route";
import { GET } from "../route";

// The person's time zone is their browser's, kept with their account, until
// they choose one in their settings, which then stays: what their agents'
// times, runs and tests go by, every copy of an agent they run included.
// Never the server's own. Live, an owner whose computer was set to Los
// Angeles had it saved again on every visit, with no way to put it right.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  state.user = await addUser(db, "maya");
});
afterAll(async () => client.close());

const put = (body: unknown) => PUT(new Request("http://localhost/api/account/timezone", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

const me = async () => {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, (state.user as schema.User).id));
  state.user = row;
  return row!;
};

describe("the account's time zone", () => {
  it("is saved from the browser, sent with the account, and goes to a build's tests", async () => {
    expect(((await (await GET(new Request("http://localhost/api/account"))).json()) as { timezone: string | null }).timezone).toBeNull();
    expect(await (await put({ timezone: "Asia/Tokyo" })).json()).toEqual({ timezone: "Asia/Tokyo", chosen: false });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, (state.user as schema.User).id));
    expect(row!.timezone).toBe("Asia/Tokyo");
    process.env.SERV_API_KEY ||= "test-serv";
    expect(buildContext(row!, null)?.timeZone).toBe("Asia/Tokyo");
  });

  it("once chosen, stays whatever a browser says, and every agent its owner runs goes by it", async () => {
    const owner = await me();
    const p = await publishedAgent(db, owner);
    const [inst] = await db.insert(schema.agentInstallations).values({ agentId: p.agent.id, versionId: p.version.id, ownerUserId: owner.id, mocks: { sheets: {}, search: {}, wallet: { balanceUsdc: 0 } }, timezone: "America/Los_Angeles", live: true }).returning();
    expect(await (await put({ timezone: "Europe/Berlin", chosen: true })).json()).toEqual({ timezone: "Europe/Berlin", chosen: true });
    expect(await me()).toMatchObject({ timezone: "Europe/Berlin", timezoneChosen: true });
    const [moved] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst!.id));
    expect(moved!.timezone).toBe("Europe/Berlin");
    // Its morning run is set again, at eight in Berlin.
    const [trigger] = await db.select().from(schema.agentTriggers).where(eq(schema.agentTriggers.installationId, inst!.id));
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(trigger!.nextAt)).toBe("08:00");
    // The browser on a computer set to Los Angeles no longer moves it.
    expect(await (await put({ timezone: "America/Los_Angeles" })).json()).toEqual({ timezone: "Europe/Berlin", chosen: true });
    expect((await me()).timezone).toBe("Europe/Berlin");
    expect(((await (await GET(new Request("http://localhost/api/account"))).json()) as { timezone: string; timezoneChosen: boolean })).toMatchObject({ timezone: "Europe/Berlin", timezoneChosen: true });
    // "Use it": back to following the browser.
    expect(await (await put({ timezone: "America/Los_Angeles", chosen: false })).json()).toEqual({ timezone: "America/Los_Angeles", chosen: false });
    expect(await me()).toMatchObject({ timezone: "America/Los_Angeles", timezoneChosen: false });
  });

  it("takes only a real time zone", async () => {
    expect((await put({ timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
  });
});
