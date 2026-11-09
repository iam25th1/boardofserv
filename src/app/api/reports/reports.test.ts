// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { publishedAgent } from "@/test/runtimeFixtures";
import { resetPaymentsConfig } from "@/lib/payments/config";
import { POST as report } from "./route";
import { POST as moderateIt } from "../admin/moderate/route";
import { POST as ask } from "../requests/route";

// Reports and the admin queue, through their routes: signed in to report,
// a reason from the list, something that exists, once; a maker by one of
// their agents, never by account id; only admins work the queue, with a
// reason, on what is waiting. And a request posted while SERV can't screen
// waits for a person.

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
  admin = await addUser(db, "reports.admin", "reports_admin");
  maker = await addUser(db, "reports.maker", "reports_maker");
  other = await addUser(db, "reports.other", "reports_other");
  agentId = (await publishedAgent(db, maker)).agent.id;
  vi.stubEnv("ADMIN_USER_IDS", admin.id);
  vi.stubEnv("SERV_API_KEY", "");
  resetPaymentsConfig();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("reporting", () => {
  it("is for people signed in, with a reason from the list, about something that exists, once", async () => {
    state.user = null;
    expect((await report(post("/api/reports", { kind: "agent", targetId: agentId, reason: "scam" }))).status).toBe(401);
    state.user = other;
    for (const bad of [null, { kind: "planet", targetId: agentId, reason: "scam" }, { kind: "agent", targetId: agentId, reason: "boring" }, { kind: "agent", targetId: agentId, reason: "scam", note: "x".repeat(1300) }, { kind: "agent", targetId: "x".repeat(80), reason: "scam" }]) {
      expect((await report(post("/api/reports", bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await report(post("/api/reports", { kind: "agent", targetId: "nope", reason: "scam" }))).status).toBe(404);
    expect((await report(post("/api/reports", { kind: "agent", targetId: agentId, reason: "scam", note: "It asked for my card." }))).status).toBe(201);
    expect((await report(post("/api/reports", { kind: "agent", targetId: agentId, reason: "spam" }))).status).toBe(409);
  });

  it("reports a maker by one of their agents, never by account id", async () => {
    state.user = other;
    // An account id isn't an agent: nothing to report, and nothing learned.
    expect((await report(post("/api/reports", { kind: "maker", targetId: maker.id, reason: "spam" }))).status).toBe(404);
    expect((await report(post("/api/reports", { kind: "maker", targetId: agentId, reason: "spam" }))).status).toBe(201);
    const [row] = await db.select().from(schema.reports).where(eq(schema.reports.kind, "maker"));
    expect(row!.targetId).toBe(maker.id);
    // A maker can't report themselves.
    state.user = maker;
    expect((await report(post("/api/reports", { kind: "maker", targetId: agentId, reason: "spam" }))).status).toBe(409);
  });
});

describe("the admin queue", () => {
  it("is admins' alone, with a reason, on what is waiting", async () => {
    const [open] = await db.select().from(schema.reports).where(eq(schema.reports.kind, "agent"));
    const body = { type: "report", id: open!.id, action: "hide", reason: "Card details asked for." };
    state.user = null;
    expect((await moderateIt(post("/api/admin/moderate", body))).status).toBe(401);
    state.user = other;
    expect((await moderateIt(post("/api/admin/moderate", body))).status).toBe(404);
    state.user = admin;
    for (const bad of [null, { ...body, action: "delete" }, { ...body, type: "user" }, { ...body, reason: "" }, { ...body, reason: "x".repeat(400) }]) {
      expect((await moderateIt(post("/api/admin/moderate", bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await moderateIt(post("/api/admin/moderate", { ...body, id: "nope" }))).status).toBe(409);
    const done = await moderateIt(post("/api/admin/moderate", body));
    expect(done.status).toBe(200);
    const safety = ((await done.json()) as { safety: { queue: { reports: { id: string }[] } } }).safety;
    expect(safety.queue.reports.map((r) => r.id)).not.toContain(open!.id);
    expect((await moderateIt(post("/api/admin/moderate", body))).status).toBe(409);
  });

  it("gets a request SERV couldn't screen, held for a person to look", async () => {
    state.user = other;
    const res = await ask(post("/api/requests", { need: "Post my prices to my group each morning", detail: "", connects: ["telegram"] }));
    expect(res.status).toBe(201);
    const { id, screen } = (await res.json()) as { id: string; screen: string };
    expect(screen).toBe("held");
    state.user = admin;
    const approved = await moderateIt(post("/api/admin/moderate", { type: "request", id, action: "approve", reason: "An ordinary job." }));
    expect(approved.status).toBe(200);
    const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, id));
    expect(row!.screen).toBe("ok");
  });
});
