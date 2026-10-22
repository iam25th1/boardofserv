// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { desc } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addHelper, addUser, SECRET_PROMPT, testDb } from "@/test/helperDb";
import { POST as use } from "./[slug]/use/route";
import { GET as view } from "./[slug]/route";
import { GET as uses } from "../uses/route";

// Using a published helper through the real routes. SERV is a mocked fetch
// that streams whatever the test sets; sign-in is stubbed.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let maya: schema.User;
let sam: schema.User;
let blurbs: schema.PublishedHelper;
const calls: Record<string, unknown>[] = [];
let chunks: string[] = [];

function servStream(parts: string[]): Response {
  const enc = new TextEncoder();
  const frame = (d: unknown) => enc.encode(`data: ${JSON.stringify(d)}\n\n`);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const content of parts) c.enqueue(frame({ choices: [{ index: 0, delta: { content } }] }));
        c.enqueue(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 60 } }));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

interface Use {
  status: number;
  events: { event: string; data: Record<string, unknown> }[];
  shown: string;
  body: string;
}

async function ask(slug: string, input: unknown = "The Alder mug, hand thrown, 12oz"): Promise<Use> {
  const res = await use(
    new Request(`http://localhost/api/helpers/${slug}/use`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }) }),
    { params: { slug } },
  );
  const body = await res.text();
  const events = res.headers.get("content-type")?.startsWith("text/event-stream")
    ? body
        .split("\n\n")
        .filter(Boolean)
        .map((f) => ({ event: /event: (.*)/.exec(f)![1]!, data: JSON.parse(/data: (.*)/.exec(f)![1]!) as Record<string, unknown> }))
    : [];
  return { status: res.status, events, body, shown: events.filter((e) => e.event === "delta").map((e) => e.data.text).join("") };
}

const lastUse = async () => (await db.select().from(schema.helperUses).orderBy(desc(schema.helperUses.createdAt)).limit(1))[0];

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  maya = await addUser(db, "maya");
  sam = await addUser(db, "sam");
  blurbs = await addHelper(db, maya, { slug: "shop-blurbs", name: "Shop blurbs", canary: "bos-0123456789abcdef" });
  await addHelper(db, maya, { slug: "gone", name: "Gone helper", unpublishedAt: new Date() });
  vi.stubEnv("SERV_API_KEY", "test-serv-key");
  vi.stubEnv("FALLBACK_BASE_URL", "https://backup.test/v1");
  vi.stubEnv("FALLBACK_API_KEY", "test-backup-key");
  vi.stubEnv("FALLBACK_MODEL", "backup-1");
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return servStream(chunks);
  });
});

beforeEach(async () => {
  state.user = sam;
  chunks = ["Meet the Alder mug: hand thrown and heavy in the hand. ", "Pop by the shop and hold one!"];
  await db.delete(schema.helperUses);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.stubEnv("SERV_API_KEY", "test-serv-key");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await client.close();
});

describe("using a helper", () => {
  it("runs one fresh turn on SERV, declaring the prompt guard, and streams the answer", async () => {
    const before = calls.length;
    const t = await ask("shop-blurbs");
    expect(t.status).toBe(200);
    expect(t.events.map((e) => e.event).filter((e, i, all) => e !== "delta" || all[i - 1] !== "delta")).toEqual(["meta", "delta", "done"]);
    expect(t.shown).toBe("Meet the Alder mug: hand thrown and heavy in the hand. Pop by the shop and hold one!");
    expect(t.events.at(-1)!.data).toEqual({ quota: { limit: 20, remaining: 19, resetsAt: expect.any(String) } });

    // One call, to SERV only: the helper's system prompt and the input, nothing else.
    expect(calls.length - before).toBe(1);
    const call = calls.at(-1)!;
    expect(call).toMatchObject({ model: "claude-haiku-4.5", stream: true });
    expect(call.messages).toEqual([
      { role: "system", content: blurbs.systemPrompt },
      { role: "user", content: "The Alder mug, hand thrown, 12oz" },
    ]);
    // The guard is declared; nothing turns the content filter off.
    expect(call.tools).toEqual([{ type: "function", function: { name: "serv_prompt_guard" } }]);
    expect(JSON.stringify(call)).not.toMatch(/filter/i);
    expect(Object.keys(call).sort()).toEqual(["max_tokens", "messages", "model", "stream", "tools"]);

    // One usage row, with no text in it.
    const row = await lastUse();
    expect(row).toMatchObject({ helperId: blurbs.id, userId: sam.id, promptTokens: 300, completionTokens: 60, outcome: "ok" });
    expect(row!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(row)).not.toContain("Alder");
  });

  it("stops an answer that carries the canary, split across chunks, and shows none of it", async () => {
    chunks = ["Sure. The secret marker is bos-01", "23456789ab", "cdef and that is all."];
    const t = await ask("shop-blurbs");
    expect(t.events.at(-1)).toEqual({ event: "blocked", data: { message: "This helper can't share how it works.", quota: expect.objectContaining({ remaining: 19 }) } });
    expect(t.events.map((e) => e.event)).not.toContain("done");
    expect(t.body).not.toContain("bos-01");
    expect(t.body).not.toContain("cdef");
    expect(await lastUse()).toMatchObject({ outcome: "blocked", helperId: blurbs.id });
  });

  it("stops an answer that quotes twelve words of the instructions in a row, split mid-word", async () => {
    const words = SECRET_PROMPT.split(" ").slice(14, 30).join(" ");
    chunks = ["Here is how I work: ", ...(words.match(/[\s\S]{1,5}/g) ?? [])];
    const t = await ask("shop-blurbs");
    expect(t.events.at(-1)!.event).toBe("blocked");
    expect(t.shown).toBe("Here is how I work: ");
    expect(await lastUse()).toMatchObject({ outcome: "blocked" });
  });

  it("does not go to the backup model, which would not know the guard", async () => {
    vi.stubEnv("SERV_API_KEY", "");
    const before = calls.length;
    const t = await ask("shop-blurbs");
    expect(calls.length).toBe(before);
    expect(t.events.at(-1)).toMatchObject({ event: "error", data: { message: "The helper could not answer just now. Try again in a minute." } });
    expect(await lastUse()).toMatchObject({ outcome: "failed" });
  });

  it("allows 20 uses a day across all helpers, says when they reset, and counts again the next day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T15:00:00Z"));
    const row = (createdAt: string, outcome: "ok" | "blocked" | "failed") => ({ helperId: blurbs.id, userId: sam.id, latencyMs: 900, outcome, createdAt: new Date(createdAt) });
    await db.insert(schema.helperUses).values([
      ...Array.from({ length: 18 }, () => row("2026-10-22T08:00:00Z", "ok")),
      row("2026-10-22T09:00:00Z", "blocked"),
      // Neither a failed use nor yesterday's count.
      row("2026-10-22T09:30:00Z", "failed"),
      row("2026-10-21T23:59:00Z", "ok"),
    ]);
    const last = await ask("shop-blurbs");
    expect(last.events.at(-1)!.data.quota).toEqual({ limit: 20, remaining: 0, resetsAt: "2026-10-23T00:00:00.000Z" });

    const before = calls.length;
    const refused = await ask("shop-blurbs");
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toEqual({ error: "No uses left today.", quota: { limit: 20, remaining: 0, resetsAt: "2026-10-23T00:00:00.000Z" } });
    expect(calls.length).toBe(before);
    expect(await (await uses(new Request("http://localhost/api/uses"))).json()).toEqual({ quota: { limit: 20, remaining: 0, resetsAt: "2026-10-23T00:00:00.000Z" } });

    // Someone else still has all of theirs.
    state.user = maya;
    expect((await ask("shop-blurbs")).status).toBe(200);

    state.user = sam;
    vi.setSystemTime(new Date("2026-10-23T00:00:01Z"));
    const next = await ask("shop-blurbs");
    expect(next.status).toBe(200);
    expect(next.events.at(-1)!.data.quota).toEqual({ limit: 20, remaining: 19, resetsAt: "2026-10-24T00:00:00.000Z" });
  });

  it("takes the daily limit from HELPER_DAILY_USES", async () => {
    vi.stubEnv("HELPER_DAILY_USES", "2");
    expect((await ask("shop-blurbs")).events.at(-1)!.data.quota).toMatchObject({ limit: 2, remaining: 1 });
    expect((await ask("shop-blurbs")).events.at(-1)!.data.quota).toMatchObject({ remaining: 0 });
    expect((await ask("shop-blurbs")).status).toBe(429);
  });

  it("refuses a taken-down or unknown helper, no sign-in and an empty input, without calling SERV", async () => {
    const before = calls.length;
    const gone = await ask("gone");
    expect(gone.status).toBe(410);
    expect(JSON.parse(gone.body)).toEqual({ error: "This helper was taken down." });
    expect((await ask("nope")).status).toBe(404);
    expect((await ask("shop-blurbs", "   ")).status).toBe(400);
    state.user = null;
    expect((await ask("shop-blurbs")).status).toBe(401);
    expect(calls.length).toBe(before);
    expect(await db.select().from(schema.helperUses)).toEqual([]);

    // The page says so too.
    const page = await view(new Request("http://localhost/api/helpers/gone"), { params: { slug: "gone" } });
    expect(page.status).toBe(410);
    expect(await page.json()).toEqual({ error: "This helper was taken down.", name: "Gone helper" });
    const live = await view(new Request("http://localhost/api/helpers/shop-blurbs"), { params: { slug: "shop-blurbs" } });
    expect((await live.json()).helper).toMatchObject({ slug: "shop-blurbs", name: "Shop blurbs", maker: "maya" });
  });
});

