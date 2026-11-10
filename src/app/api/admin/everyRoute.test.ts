// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";

// Every admin route, found on disk so a new one can't be missed, checks
// for an admin on the server before it does anything: 401 signed out, 404
// for anyone else, for every method it answers.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let someone: schema.User;
beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  someone = await addUser(db, "not.an.admin");
  vi.stubEnv("ADMIN_USER_IDS", "did:privy:the-admin");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

const files = execSync("find src/app/api/admin -name route.ts", { encoding: "utf8" }).trim().split("\n").sort();
const ID = "00000000-0000-4000-8000-000000000001";

describe("every admin route", () => {
  it("is found, and checks for an admin first", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)("%s refuses everyone but an admin, for every method", async (file) => {
    const mod = (await import(`@/${file.replace(/^src\//, "").replace(/\.ts$/, "")}`)) as Record<string, unknown>;
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function");
    expect(methods.length, file).toBeGreaterThan(0);
    for (const method of methods) {
      const call = () =>
        (mod[method] as (req: Request, ctx: unknown) => Promise<Response>)(
          new Request(`http://localhost/api/admin/x?id=${ID}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify({ action: "approve", paused: true, reason: "testing it" }) }),
          { params: { id: ID } },
        );
      state.user = null;
      expect((await call()).status, `${method} ${file} signed out`).toBe(401);
      state.user = someone;
      expect((await call()).status, `${method} ${file} as someone else`).toBe(404);
    }
  });
});
