// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { PUT } from "./route";
import { GET } from "../route";

// "Show details" on the agent page is the maker's own choice, kept with
// their account and sent with it.

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

const put = (body: unknown) => PUT(new Request("http://localhost/api/account/details", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const account = async () => (await (await GET(new Request("http://localhost/api/account"))).json()) as { agentDetails: boolean };

describe("show details", () => {
  it("is off until the maker turns it on, and stays as they left it", async () => {
    expect((await account()).agentDetails).toBe(false);
    expect(await (await put({ on: true })).json()).toEqual({ agentDetails: true });
    state.user = { ...(state.user as schema.User), agentDetails: true };
    expect((await account()).agentDetails).toBe(true);
    const [row] = await db.select({ on: schema.users.agentDetails }).from(schema.users);
    expect(row!.on).toBe(true);
    expect((await put({ on: "yes" })).status).toBe(400);
    state.user = null;
    expect((await put({ on: false })).status).toBe(401);
  });
});
