// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { buildContext } from "@/lib/agents/context";
import { PUT } from "./route";
import { GET } from "../route";

// The person's time zone is their browser's, kept with their account: what
// their agents' times and tests go by. Never the server's own.

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

describe("the account's time zone", () => {
  it("is saved from the browser, sent with the account, and goes to a build's tests", async () => {
    expect(((await (await GET(new Request("http://localhost/api/account"))).json()) as { timezone: string | null }).timezone).toBeNull();
    expect(await (await put({ timezone: "Asia/Tokyo" })).json()).toEqual({ timezone: "Asia/Tokyo" });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, (state.user as schema.User).id));
    expect(row!.timezone).toBe("Asia/Tokyo");
    process.env.SERV_API_KEY ||= "test-serv";
    expect(buildContext(row!, null)?.timeZone).toBe("Asia/Tokyo");
  });

  it("takes only a real time zone", async () => {
    expect((await put({ timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
  });
});
