// @vitest-environment node
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { fakeNet } from "@/test/fakeNet";
import { FAKE_TYPEFORM_TOKEN, fakeTypeform } from "@/test/fakeTypeform";

// Connect Typeform: the owner pastes a personal token; it is tried once,
// kept encrypted like every connection secret, never shown again, and can
// be removed.

process.env.OPENSERV_KEY_ENC_KEY ||= randomBytes(32).toString("base64");
const net = fakeNet();
fakeTypeform(net);
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));
vi.mock("@/lib/agents/runtime/context", async (load) => {
  const real = await load<typeof import("@/lib/agents/runtime/context")>();
  return { ...real, serverRuntime: () => ({ ...real.serverRuntime(), services: { ...real.serverRuntime().services, fetch: net.fetch } }) };
});

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  state.user = await addUser(db, "maya");
});
afterAll(async () => client.close());

const req = (url: string, method: string, body?: unknown) => new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("connecting Typeform", () => {
  it("keeps a token that works, encrypted, shows only the account's name, and forgets it on disconnect", async () => {
    const connect = await import("./route");
    const list = await import("../route");
    const bad = await connect.POST(req("/api/connections/typeform", "POST", { token: "tfp_this_one_does_not_work" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "That token didn't work with Typeform: check it can read forms and responses, or make a new one." });

    const res = await connect.POST(req("/api/connections/typeform", "POST", { token: FAKE_TYPEFORM_TOKEN }));
    expect(await res.json()).toEqual({ connected: true, label: "Typeform (sample-maker)" });
    const [row] = await db.select().from(schema.connections).where(eq(schema.connections.provider, "typeform"));
    expect(row!.secretEncrypted).not.toContain(FAKE_TYPEFORM_TOKEN);
    expect(row!.label).toBe("Typeform (sample-maker)");

    const listed = await (await list.GET(req("/api/connections", "GET"))).json();
    expect(JSON.stringify(listed)).not.toContain(FAKE_TYPEFORM_TOKEN);
    expect(listed.connections).toEqual([expect.objectContaining({ provider: "typeform", name: "Typeform", label: "Typeform (sample-maker)" })]);
    expect(listed.available.typeform).toBe(true);

    const gone = await list.DELETE(req("/api/connections?provider=typeform", "DELETE"));
    expect(gone.status).toBe(200);
    expect(await db.select().from(schema.connections).where(eq(schema.connections.provider, "typeform"))).toEqual([]);
  });
});
