// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime } from "@/test/runtimeFixtures";
import { PATCH } from "./route";

// Raising what asks first, through the route: only its owner, only tools
// it uses that change or send something, an auto limit in bounds. Nobody
// lowers the floor.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let owner: schema.User;
let other: schema.User;
let id: string;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  owner = await addUser(db, "policy.owner");
  other = await addUser(db, "policy.other");
  id = (await installed(testRuntime(db), owner, await publishedAgent(db, owner))).id;
});
afterAll(async () => client.close());

const patch = (body: unknown) => PATCH(new Request(`http://localhost/api/installations/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: { id } });
const stored = async () => (await db.select({ p: schema.agentInstallations.policy }).from(schema.agentInstallations).where(eq(schema.agentInstallations.id, id)))[0]!.p;

describe("raising what asks first", () => {
  it("lets its owner raise a tool that changes something, and keeps reads and unused tools out", async () => {
    state.user = owner;
    const res = await patch({ askFor: ["sheets.write", "sheets.read", "wallet.pay", "telegram.ask"], autoSpendUsdc: 25 });
    expect(res.status).toBe(200);
    expect(await stored()).toEqual({ askFor: ["sheets.write"], autoSpendUsdc: 25 });
    const body = (await res.json()) as { installation: { safety: { tools: { tool: string; asks: boolean }[] } } };
    expect(body.installation.safety.tools.find((t) => t.tool === "sheets.write")!.asks).toBe(true);
  });

  it("turns away anyone else, and nobody signed in", async () => {
    state.user = other;
    expect((await patch({ askFor: [], autoSpendUsdc: 1000 })).status).toBe(404);
    state.user = null;
    expect((await patch({ askFor: [], autoSpendUsdc: 1000 })).status).toBe(401);
    expect(await stored()).toEqual({ askFor: ["sheets.write"], autoSpendUsdc: 25 });
  });

  it("refuses an auto limit out of bounds, an unknown tool and a malformed body", async () => {
    state.user = owner;
    for (const body of [{ askFor: [], autoSpendUsdc: -1 }, { askFor: [], autoSpendUsdc: 1e6 }, { askFor: ["shell.exec"], autoSpendUsdc: 0 }, { askFor: "sheets.write", autoSpendUsdc: 0 }, null]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await stored()).toEqual({ askFor: ["sheets.write"], autoSpendUsdc: 25 });
  });
});
