// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, testRuntime } from "@/test/runtimeFixtures";
import { resetPaymentsConfig } from "@/lib/payments/config";
import { JobTools } from "@/lib/agents/runtime/tools";
import type { AuditPageDTO } from "@/lib/types";
import { GET as adminAudit } from "./route";
import { GET as renterAudit } from "../../installations/[id]/audit/route";
import { GET as makerAudit } from "../../agents/[id]/audit/route";

// The audit log through its routes: the renter's own installation only,
// the maker's own agent only and with renters' data hidden, all of it for
// admins only. Anyone else gets a 404 (a 401 signed out), never a line.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let admin: schema.User;
let maker: schema.User;
let renter: schema.User;
let other: schema.User;
let agentId: string;
let installationId: string;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  admin = await addUser(db, "auditroutes.admin", "auditroutes_admin");
  maker = await addUser(db, "auditroutes.maker", "auditroutes_maker");
  renter = await addUser(db, "auditroutes.renter", "auditroutes_renter");
  other = await addUser(db, "auditroutes.other", "auditroutes_other");
  const rt = testRuntime(db);
  const p = await publishedAgent(db, maker);
  agentId = p.agent.id;
  const inst = await installed(rt, renter, p);
  installationId = inst.id;
  const d = restockDefinition();
  await new JobTools(rt, inst, d, null).call(d.steps.find((s) => s.id === "record")!, "sheets.write", { sheet: "Orders", rows: [{ fabric: "Herringbone tweed", metres: 7 }] });
  vi.stubEnv("ADMIN_USER_IDS", admin.id);
  resetPaymentsConfig();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

const get = (url: string) => new Request(`http://localhost${url}`);
const lines = async (res: Response) => ((await res.json()) as { audit: AuditPageDTO }).audit.entries;

describe("the audit log's routes", () => {
  it("give the renter their own installation's log, and nobody else's", async () => {
    const p = { params: Promise.resolve({ id: installationId }) };
    state.user = null;
    expect((await renterAudit(get(`/api/installations/${installationId}/audit`), p)).status).toBe(401);
    for (const who of [other, maker, admin]) {
      state.user = who;
      expect((await renterAudit(get(`/api/installations/${installationId}/audit`), p)).status, who.handle).toBe(404);
    }
    state.user = renter;
    expect((await renterAudit(get("/api/installations/nope/audit"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
    const mine = await lines(await renterAudit(get(`/api/installations/${installationId}/audit?before=x`), p));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.what).toContain('"Orders"');
  });

  it("give the maker their agent's log with the renter's data hidden", async () => {
    const p = { params: Promise.resolve({ id: agentId }) };
    state.user = null;
    expect((await makerAudit(get(`/api/agents/${agentId}/audit`), p)).status).toBe(401);
    for (const who of [other, renter, admin]) {
      state.user = who;
      expect((await makerAudit(get(`/api/agents/${agentId}/audit`), p)).status, who.handle).toBe(404);
    }
    state.user = maker;
    const res = await makerAudit(get(`/api/agents/${agentId}/audit`), p);
    const text = await res.clone().text();
    expect((await lines(res))[0]).toMatchObject({ renter: "Renter 1", what: null, outcome: "ran" });
    for (const secret of ["Herringbone", "Orders", "auditroutes_renter", renter.id, installationId]) expect(text).not.toContain(secret);
  });

  it("give an admin all of it, and nobody else", async () => {
    state.user = null;
    expect((await adminAudit(get("/api/admin/audit"))).status).toBe(401);
    for (const who of [other, renter, maker]) {
      state.user = who;
      expect((await adminAudit(get("/api/admin/audit"))).status, who.handle).toBe(404);
    }
    state.user = admin;
    const all = await lines(await adminAudit(get(`/api/admin/audit?installation=${installationId}`)));
    expect(all[0]).toMatchObject({ renter: "@auditroutes_renter" });
    expect(await lines(await adminAudit(get(`/api/admin/audit?agent=${agentId}&before=1`)))).toEqual([]);
  });
});
