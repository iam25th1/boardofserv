// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { createUser } from "@/lib/users";
import { GET as account } from "../route";
import { GET, PATCH } from "./route";

// Handles on the real routes and an in-memory Postgres with the real
// migrations. Sign-in is stubbed; random draws are scripted when a test
// needs a collision.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown, draws: [] as number[] }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  const randomInt = (min: number, max: number) => state.draws.shift() ?? real.randomInt(min, max);
  return { ...real, default: { ...real, randomInt }, randomInt };
});

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let maya: schema.User;

const check = async (handle: string) => (await GET(new Request(`http://localhost/api/account/handle?handle=${encodeURIComponent(handle)}`))).json();
const set = (handle: unknown) =>
  PATCH(new Request("http://localhost/api/account/handle", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle }) }));

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  maya = await addUser(db, "maya", "maker_1001");
  await addUser(db, "sam", "sam");
});

beforeEach(async () => {
  state.user = (await db.query.users.findFirst({ where: eq(schema.users.id, maya.id) }))!;
  state.draws = [];
});

afterAll(async () => {
  await client.close();
});

describe("new users", () => {
  it("get a random handle like maker_4821 that is not chosen yet", async () => {
    const user = await createUser({ userId: "did:privy:new", email: "new@example.com" });
    expect(user!.handle).toMatch(/^maker_\d{4}$/);
    expect(user!.handleChosen).toBe(false);
  });

  it("draw again when the random handle is taken", async () => {
    await addUser(db, "first", "maker_4821");
    state.draws = [4821, 4821, 5150];
    const user = await createUser({ userId: "did:privy:second", email: "second@example.com" });
    expect(user!.handle).toBe("maker_5150");
  });

  it("get the row a racing first request already made", async () => {
    const one = await createUser({ userId: "did:privy:race", email: "race@example.com" });
    const two = await createUser({ userId: "did:privy:race", email: "race@example.com" });
    expect(two!.id).toBe(one!.id);
  });

  it("can't share a handle that differs only in case, even straight in the database", async () => {
    await expect(db.insert(schema.users).values({ privyUserId: "did:privy:loud", handle: "SAM" })).rejects.toThrow();
  });
});

describe("checking a handle", () => {
  it("says what is wrong with its form", async () => {
    expect(await check("ab")).toMatchObject({ available: false, error: "Use 3 to 20 characters." });
    expect(await check("a".repeat(21))).toMatchObject({ available: false, error: "Use 3 to 20 characters." });
    expect(await check("maya r")).toMatchObject({ available: false, error: "Use only letters, numbers and underscores." });
    expect(await check("maya-r")).toMatchObject({ available: false, error: "Use only letters, numbers and underscores." });
    for (const word of ["admin", "board", "serv", "boardofserv", "support", "help", "Help"]) {
      expect(await check(word)).toMatchObject({ available: false, error: "That handle is reserved." });
    }
  });

  it("says when someone has it, ignoring case", async () => {
    expect(await check("SAM")).toEqual({ handle: "sam", available: false, error: "That handle is taken." });
  });

  it("is free when no one has it, or when it is already yours", async () => {
    expect(await check("@Maya_R")).toEqual({ handle: "maya_r", available: true });
    expect(await check("maker_1001")).toEqual({ handle: "maker_1001", available: true });
  });

  it("needs sign-in", async () => {
    state.user = null;
    expect((await GET(new Request("http://localhost/api/account/handle?handle=maya"))).status).toBe(401);
  });
});

describe("setting a handle", () => {
  it("keeps it in lower case and marks it chosen, and the account menu sees it", async () => {
    const res = await set("Maya_R");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handle: "maya_r", handleChosen: true });
    state.user = (await db.query.users.findFirst({ where: eq(schema.users.id, maya.id) }))!;
    expect(await (await account(new Request("http://localhost/api/account"))).json()).toMatchObject({ handle: "maya_r", handleChosen: true });
  });

  it("confirms the random one as chosen", async () => {
    const [user] = await db.insert(schema.users).values({ privyUserId: "did:privy:keep", handle: "maker_7777" }).returning();
    state.user = user;
    expect(await (await set("maker_7777")).json()).toEqual({ handle: "maker_7777", handleChosen: true });
  });

  it("refuses one that is taken, reserved or malformed, and leaves the handle as it was", async () => {
    const before = (await db.query.users.findFirst({ where: eq(schema.users.id, maya.id) }))!.handle;
    const taken = await set("Sam");
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "That handle is taken." });
    expect((await set("admin")).status).toBe(400);
    expect((await set("no spaces")).status).toBe(400);
    expect((await set(42)).status).toBe(400);
    expect((await db.query.users.findFirst({ where: eq(schema.users.id, maya.id) }))!.handle).toBe(before);
  });

  it("needs sign-in", async () => {
    state.user = null;
    expect((await set("maya_r")).status).toBe(401);
  });
});
