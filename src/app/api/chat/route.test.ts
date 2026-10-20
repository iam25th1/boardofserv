// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { nodesOf, sketchFromDTO, statusLine } from "@/lib/agentSketch";
import type { SketchDTO } from "@/lib/types";
import { POST } from "./route";

// Whole chat turns through the real /api/chat route: the real migrations run
// on an in-memory Postgres, sign-in is stubbed, and SERV is a mocked fetch.

const state = vi.hoisted(() => ({
  db: null as unknown as PgliteDatabase<typeof schema>,
  user: null as unknown,
}));
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_, key) => Reflect.get(state.db, key) }),
}));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
const servCalls: { messages: { role: string; content: string }[] }[] = [];
let nextReply: string[] = [];

// SERV's stream shape: one delta per chunk, usage at the end, then [DONE].
function servStream(chunks: string[]): Response {
  const enc = new TextEncoder();
  const frame = (d: unknown) => enc.encode(`data: ${JSON.stringify(d)}\n\n`);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const content of chunks) c.enqueue(frame({ choices: [{ index: 0, delta: { content } }] }));
        c.enqueue(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 60 } }));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

interface Turn {
  events: { event: string; data: Record<string, unknown> }[];
  shown: string;
  sketch: { sketch: SketchDTO; choices: string[] } | undefined;
  conversationId: string;
}

async function turn(content: string, conversationId?: string): Promise<Turn> {
  const res = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, conversationId }),
    }),
  );
  const body = await res.text();
  const events = body
    .split("\n\n")
    .filter(Boolean)
    .map((f) => ({ event: /event: (.*)/.exec(f)![1]!, data: JSON.parse(/data: (.*)/.exec(f)![1]!) as Record<string, unknown> }));
  return {
    events,
    shown: events.filter((e) => e.event === "delta").map((e) => e.data.text).join(""),
    sketch: events.find((e) => e.event === "sketch")?.data as Turn["sketch"],
    conversationId: events.find((e) => e.event === "meta")!.data.conversationId as string,
  };
}

const block = (o: Record<string, unknown>) => `\n\n<<<SKETCH\n${JSON.stringify(o)}\nSKETCH>>>`;

beforeAll(async () => {
  client = new PGlite();
  state.db = drizzle(client, { schema });
  await migrate(state.db, { migrationsFolder: join(__dirname, "../../../lib/db/migrations") });
  [state.user] = await state.db.insert(schema.users).values({ privyUserId: "did:privy:test", email: "maya@example.com" }).returning();
  vi.stubEnv("SERV_API_KEY", "test-serv-key");
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    servCalls.push(JSON.parse(String(init.body)));
    return servStream(nextReply);
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await client.close();
});

describe("a chat turn with a sketch", () => {
  let convo = "";

  it("streams the reply without the block, then the sketch, then done, and saves both", async () => {
    const reply = "Good one. How often should it check the price?";
    const sketch = {
      name: "ETH floor watch",
      kind: "watcher",
      watches: "ETH price",
      when: "below $2,000",
      how: null,
      tells: null,
      asking: "how",
      choices: ["Every minute", "Every 5 minutes", "Every hour"],
    };
    // The marker arrives split across chunks, as a real stream can do.
    const full = reply + block(sketch);
    nextReply = [full.slice(0, 20), full.slice(20, reply.length + 4), full.slice(reply.length + 4, reply.length + 9), full.slice(reply.length + 9)];
    const t = await turn("Tell me when ETH drops below $2,000");
    convo = t.conversationId;

    expect(t.events.map((e) => e.event).filter((e, i, all) => e !== "delta" || all[i - 1] !== "delta")).toEqual(["meta", "delta", "sketch", "done"]);
    expect(t.shown.trimEnd()).toBe(reply);
    expect(t.shown).not.toContain("<");
    expect(t.sketch?.choices).toEqual(sketch.choices);
    const { choices: _choices, ...fields } = sketch;
    expect(t.sketch?.sketch).toEqual({ ...fields, live: false });

    const [saved] = await state.db.select().from(schema.messages).where(eq(schema.messages.role, "assistant"));
    expect(saved?.content).toBe(reply);
    const row = await state.db.query.agentSketches.findFirst({ where: eq(schema.agentSketches.conversationId, convo) });
    expect(row).toMatchObject({ name: "ETH floor watch", watches: "ETH price", when: "below $2,000", how: null, asking: "how", live: false });
    const [usage] = await state.db.select().from(schema.replyUsage);
    expect(usage).toMatchObject({ provider: "serv", outcome: "ok", sketchOk: true, promptTokens: 300, completionTokens: 60 });

    // What the dock shows: watch lit, decide waiting on "how", tell you not yet.
    const dock = sketchFromDTO(t.sketch!.sketch);
    expect(nodesOf(dock)).toEqual({ watch: "on", decide: "ask", tell: "off" });
    expect(dock.how.status).toBe("waiting");
    expect(statusLine(dock, false)).toBe("Waiting on one answer from you");
  });

  it("merges the next sketch: new values land, nulls keep what was stored", async () => {
    nextReply = [
      "Every 5 minutes it is. Where should it tell you?",
      block({ name: null, kind: null, watches: null, when: null, how: "every 5 minutes", tells: null, asking: "tells", choices: ["Telegram", "Email"] }),
    ];
    const t = await turn("Every 5 minutes", convo);

    // The model saw the stored sketch on its previous reply.
    const sent = servCalls.at(-1)!.messages;
    const previous = sent.filter((m) => m.role === "assistant").at(-1)!;
    expect(previous.content).toContain('"watches":"ETH price"');
    expect(previous.content.startsWith("Good one.")).toBe(true);

    expect(t.sketch?.sketch).toMatchObject({ name: "ETH floor watch", watches: "ETH price", when: "below $2,000", how: "every 5 minutes", asking: "tells" });
    expect(nodesOf(sketchFromDTO(t.sketch!.sketch))).toEqual({ watch: "on", decide: "on", tell: "ask" });
  });

  it("keeps the reply and the stored sketch when the block is invalid", async () => {
    nextReply = ["Telegram works. Anything else?", "\n\n<<<SKETCH\n{\"name\": \"broken\",\nSKETCH>>>"];
    const t = await turn("Telegram", convo);
    expect(t.shown.trimEnd()).toBe("Telegram works. Anything else?");
    expect(t.sketch).toBeUndefined();
    expect(t.events.at(-1)?.event).toBe("done");
    const row = await state.db.query.agentSketches.findFirst({ where: eq(schema.agentSketches.conversationId, convo) });
    expect(row).toMatchObject({ name: "ETH floor watch", how: "every 5 minutes", tells: null });
    const usage = await state.db.select().from(schema.replyUsage).orderBy(schema.replyUsage.createdAt);
    expect(usage.map((u) => u.sketchOk)).toEqual([true, true, false]);
  });
});
