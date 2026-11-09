// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { publishedAgent } from "@/test/runtimeFixtures";
import { resetPaymentsConfig } from "@/lib/payments/config";
import { POST as freezeIt } from "./route";
import { POST as liftIt } from "./[id]/route";
import { POST as kill } from "../../agents/[id]/kill/route";

// The admin's freezes and the maker's kill switch, through their routes:
// only admins freeze, only with a reason, only something that exists; only
// an agent's maker stops it.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let admin: schema.User;
let maker: schema.User;
let other: schema.User;
let agentId: string;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  admin = await addUser(db, "routes.admin", "site_admin");
  maker = await addUser(db, "routes.maker", "a_maker");
  other = await addUser(db, "routes.other", "someone");
  agentId = (await publishedAgent(db, maker)).agent.id;
  vi.stubEnv("ADMIN_USER_IDS", admin.id);
  resetPaymentsConfig();
});
afterAll(async () => client.close());

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("freezing", () => {
  it("is for admins, with a reason, on something that exists", async () => {
    state.user = other;
    expect((await freezeIt(post("/api/admin/freezes", { kind: "agent", target: agentId, reason: "Reported." }))).status).toBe(404);
    state.user = null;
    expect((await freezeIt(post("/api/admin/freezes", { kind: "agent", target: agentId, reason: "Reported." }))).status).toBe(401);
    state.user = admin;
    for (const bad of [{ kind: "planet", target: agentId, reason: "Reported." }, { kind: "agent", target: agentId, reason: "x" }, { kind: "agent", target: "", reason: "Reported." }, null]) {
      expect((await freezeIt(post("/api/admin/freezes", bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await freezeIt(post("/api/admin/freezes", { kind: "agent", target: "not-an-id", reason: "Reported." }))).status).toBe(404);
    expect((await freezeIt(post("/api/admin/freezes", { kind: "maker", target: "@nobody_here", reason: "Reported." }))).status).toBe(404);
    const ok = await freezeIt(post("/api/admin/freezes", { kind: "maker", target: "@a_maker", reason: "Reported for scams." }));
    expect(ok.status).toBe(201);
    const id = ((await ok.json()) as { safety: { freezes: { id: string; target: string }[] } }).safety.freezes[0]!;
    expect(id.target).toBe("@a_maker");
    expect((await liftIt(post(`/api/admin/freezes/${id.id}`, { reason: "" }), { params: { id: id.id } })).status).toBe(400);
    expect((await liftIt(post("/api/admin/freezes/nope", { reason: "Checked." }), { params: { id: "nope" } })).status).toBe(404);
    expect((await liftIt(post(`/api/admin/freezes/${id.id}`, { reason: "Checked." }), { params: { id: id.id } })).status).toBe(200);
  });
});

describe("the kill switch", () => {
  it("is its maker's alone, and takes only stop or start", async () => {
    state.user = other;
    expect((await kill(post(`/api/agents/${agentId}/kill`, { action: "stop" }), { params: { id: agentId } })).status).toBe(404);
    state.user = maker;
    expect((await kill(post(`/api/agents/${agentId}/kill`, { action: "explode" }), { params: { id: agentId } })).status).toBe(400);
    expect((await kill(post(`/api/agents/${agentId}/kill`, { action: "stop", note: "x".repeat(400) }), { params: { id: agentId } })).status).toBe(400);
    const stopped = await kill(post(`/api/agents/${agentId}/kill`, { action: "stop" }), { params: { id: agentId } });
    expect(((await stopped.json()) as { dashboard: { stopped: unknown } }).dashboard.stopped).not.toBeNull();
  });
});
