// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { FAKE_TYPEFORM_TOKEN, fakeTypeform } from "@/test/fakeTypeform";
import { connectService, ConnectRefused } from "./connect";
import { canWrite, connectionsOf, keep, setWrites } from "./vault";

// Connecting a service: what the owner pastes is checked once with the
// service ("Connected as X", or a plain reason and nothing kept), kept
// encrypted, never shown again, and only reads until the owner turns
// writing on.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
  fakeTypeform(rt.net);
  owner = await addUser(db, "connect.owner");
});
afterAll(async () => client.close());

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof ConnectRefused ? { status: e.status, message: e.message } : e));

describe("checking a key when it is saved", () => {
  it("keeps one that works, saying whose it is, and never shows it again", async () => {
    const { label } = await connectService(rt, owner.id, "typeform", { token: FAKE_TYPEFORM_TOKEN });
    expect(label).toBe("Typeform (sample-maker)");
    const [row] = await db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, owner.id));
    expect(row!.secretEncrypted).not.toContain(FAKE_TYPEFORM_TOKEN);
    const shown = await connectionsOf(rt, owner.id);
    expect(shown).toEqual([expect.objectContaining({ provider: "typeform", label: "Typeform (sample-maker)", writes: false })]);
    expect(JSON.stringify(shown)).not.toContain(FAKE_TYPEFORM_TOKEN);
    expect(rt.logged.join("\n")).not.toContain(FAKE_TYPEFORM_TOKEN);
    // The check went to Typeform with the token in its one header.
    const call = rt.net.calls.find((c) => c.url.pathname === "/me")!;
    expect(call.url.host).toBe("api.typeform.com");
    expect(call.headers.get("authorization")).toBe(`Bearer ${FAKE_TYPEFORM_TOKEN}`);
  });

  it("refuses one that doesn't, in plain words, and keeps nothing", async () => {
    const other = await addUser(db, "connect.other");
    expect(await refusal(connectService(rt, other.id, "typeform", { token: "tfp_not_a_real_token_000" }))).toEqual({ status: 400, message: "That token didn't work with Typeform: check it can read forms and responses, or make a new one." });
    expect(await refusal(connectService(rt, other.id, "typeform", {}))).toEqual({ status: 400, message: "Paste your Typeform personal token." });
    expect(await refusal(connectService(rt, other.id, "telegram", { token: "x" }))).toMatchObject({ status: 400 });
    expect(await refusal(connectService(rt, other.id, "nosuchservice", { token: "x" }))).toMatchObject({ status: 400 });
    rt.net.on(/api\.typeform\.com\/me/, () => {
      throw new Error("network down");
    });
    expect(await refusal(connectService(rt, other.id, "typeform", { token: FAKE_TYPEFORM_TOKEN }))).toEqual({ status: 503, message: "Typeform couldn't be reached just now. Try again in a minute." });
    expect(await connectionsOf(rt, other.id)).toEqual([]);
  });
});

describe("the write switch", () => {
  it("is on for the owner's own Telegram chat and Google tabs, as before, and off for a pasted key", async () => {
    const someone = await addUser(db, "connect.switch");
    await keep(rt, someone.id, "telegram", "@someone", { chatId: 1, userId: 1 });
    await keep(rt, someone.id, "google", "someone@example.com", { refreshToken: "r", accessToken: null, expiresAt: null, scope: "s" });
    expect(await canWrite(rt, someone.id, "telegram")).toBe(true);
    expect(await canWrite(rt, someone.id, "google")).toBe(true);
    // Off, then on again: the owner's own choice, kept across a reconnect.
    expect(await setWrites(rt, someone.id, "telegram", false)).toBe(true);
    expect(await canWrite(rt, someone.id, "telegram")).toBe(false);
    await keep(rt, someone.id, "telegram", "@someone", { chatId: 1, userId: 1 });
    expect(await canWrite(rt, someone.id, "telegram")).toBe(false);
    expect(await setWrites(rt, someone.id, "telegram", true)).toBe(true);
    expect(await canWrite(rt, someone.id, "telegram")).toBe(true);
    // A service that only reads has no switch; one not connected can't.
    expect(await setWrites(rt, owner.id, "typeform", true)).toBe(false);
    expect(await canWrite(rt, owner.id, "typeform")).toBe(false);
    expect(await setWrites(rt, someone.id, "typeform", true)).toBe(false);
  });
});
