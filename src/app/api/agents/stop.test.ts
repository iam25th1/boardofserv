// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { modelConfig } from "@/lib/model";
import { jobFor, servOnly, startPlan, STOPPED_NOTE } from "@/lib/agents/build";
import { createAgent, draftOf } from "@/lib/agents/store";
import * as stop from "./[id]/stop/route";

// Stop, while the chat works out an agent's steps: the work stops on the
// server where it is (its model call aborted), nothing more is started,
// and the draft rests with what was done, for the maker to change and
// send again.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
const asked: string[] = [];
let aborted = 0;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  state.user = await addUser(db, "ana");
  // SERV takes its time over the outline: it answers only when stopped.
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { response_format?: { json_schema?: { name?: string } } };
    asked.push(body.response_format?.json_schema?.name ?? "");
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted += 1;
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await client.close();
});

const interview = { name: "Price watcher", kind: "agent" as const, watches: "a product page", when: null, how: null, tells: null, takes: null, does: null, gives: null, asking: null, live: false };

describe("Stop while the steps are worked out", () => {
  it("aborts the model call, starts nothing more, and leaves the draft resting with a plain note", async () => {
    const user = state.user as schema.User;
    const { agent, draft } = await createAgent({ ownerUserId: user.id, conversationId: null, name: "Price watcher" });
    const ctx = { userId: user.id, conversationId: null, ownKey: false, serv: servOnly(modelConfig({ SERV_API_KEY: "test-serv" })) };
    expect(startPlan(draft, { interview, history: [{ role: "user", content: "Watch a price for me." }] }, ctx, "plan", { stop: true })).toBe(true);
    for (let i = 0; i < 50 && !asked.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual(["agent_outline"]);
    const res = await stop.POST(new Request(`http://localhost/api/agents/${agent.id}/stop`, { method: "POST" }), { params: Promise.resolve({ id: agent.id }) });
    const out = (await res.json()) as { stopped: boolean; agent: { buildState: string; buildNote: string | null } };
    expect(out.stopped).toBe(true);
    expect(out.agent).toMatchObject({ buildState: "idle", buildNote: STOPPED_NOTE });
    expect(aborted).toBe(1);
    expect(jobFor(draft.id)).toBeUndefined();
    // Nothing more was asked after the stop.
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual(["agent_outline"]);
    expect((await draftOf(agent.id))!.buildState).toBe("idle");
    // Stop with nothing running says so.
    const again = (await (await stop.POST(new Request(`http://localhost/api/agents/${agent.id}/stop`, { method: "POST" }), { params: Promise.resolve({ id: agent.id }) })).json()) as { stopped: boolean };
    expect(again.stopped).toBe(false);
  });
});
