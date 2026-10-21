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
// on an in-memory Postgres, sign-in is stubbed, and SERV is a mocked fetch
// that streams the reply and then answers the sketch extraction.

const state = vi.hoisted(() => ({
  db: null as unknown as PgliteDatabase<typeof schema>,
  user: null as unknown,
}));
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_, key) => Reflect.get(state.db, key) }),
}));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
type Body = { stream: boolean; messages: { role: string; content: string }[]; response_format?: unknown };
const calls: Body[] = [];
// What the next turn's two calls answer: the reply's chunks, then the
// extraction's JSON text (or an HTTP status for a failed extraction).
let nextReply: string[] = [];
let nextSketch: string | number = "";

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

function servJson(content: string | number): Response {
  if (typeof content === "number") return new Response("{}", { status: content });
  return Response.json({
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 250, completion_tokens: 70 },
  });
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

const extraction = (o: Record<string, unknown>) =>
  JSON.stringify({ name: "", kind: "none", watches: "", when: "", how: "", tells: "", asking: "none", choices: [], ...o });

async function sketchRow(conversationId: string) {
  return state.db.query.agentSketches.findFirst({ where: eq(schema.agentSketches.conversationId, conversationId) });
}

beforeAll(async () => {
  client = new PGlite();
  state.db = drizzle(client, { schema });
  await migrate(state.db, { migrationsFolder: join(__dirname, "../../../lib/db/migrations") });
  [state.user] = await state.db.insert(schema.users).values({ privyUserId: "did:privy:test", email: "maya@example.com" }).returning();
  vi.stubEnv("SERV_API_KEY", "test-serv-key");
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    calls.push(body);
    return body.stream ? servStream(nextReply) : servJson(nextSketch);
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await client.close();
});

describe("a chat turn with a sketch", () => {
  let convo = "";

  it("streams the reply, then extracts the sketch, saves it and sends it before done", async () => {
    const reply = "Good one. How often should it check the price?";
    nextReply = [reply.slice(0, 20), reply.slice(20)];
    nextSketch = extraction({
      name: "ETH floor watch",
      kind: "watcher",
      watches: "ETH price",
      when: "below $2,000",
      asking: "how",
      choices: ["Every minute", "Every 5 minutes", "Every hour"],
    });
    const t = await turn("Tell me when ETH drops below $2,000");
    convo = t.conversationId;

    expect(t.events.map((e) => e.event).filter((e, i, all) => e !== "delta" || all[i - 1] !== "delta")).toEqual(["meta", "delta", "reply_end", "sketch", "done"]);
    expect(t.shown).toBe(reply);
    // reply_end comes once the reply is saved, so it already names the message.
    const ids = t.events.filter((e) => e.event === "reply_end" || e.event === "done").map((e) => e.data.messageId);
    expect(ids[0]).toBeTruthy();
    expect(ids).toEqual([ids[0], ids[0]]);
    expect(t.sketch?.choices).toEqual(["Every minute", "Every 5 minutes", "Every hour"]);
    expect(t.sketch?.sketch).toEqual({
      name: "ETH floor watch",
      kind: "watcher",
      watches: "ETH price",
      when: "below $2,000",
      how: null,
      tells: null,
      asking: "how",
      live: false,
    });

    // Two calls: the streamed reply, then the strict JSON extraction.
    const [replyCall, extractCall] = calls.slice(-2);
    expect(replyCall).toMatchObject({ stream: true });
    expect(replyCall!.messages[0]!.content).toContain("Known so far: nothing yet; missing: watches, when, how, tells.");
    expect(extractCall).toMatchObject({ stream: false, response_format: { type: "json_schema", json_schema: { name: "agent_sketch", strict: true } } });
    expect(extractCall!.messages[1]!.content).toContain("The person said: Tell me when ETH drops below $2,000");
    expect(extractCall!.messages[1]!.content).toContain(`The reply: ${reply}`);

    const [saved] = await state.db.select().from(schema.messages).where(eq(schema.messages.role, "assistant"));
    expect(saved?.content).toBe(reply);
    expect(await sketchRow(convo)).toMatchObject({ name: "ETH floor watch", watches: "ETH price", when: "below $2,000", how: null, asking: "how", live: false });
    const [usage] = await state.db.select().from(schema.replyUsage);
    expect(usage).toMatchObject({
      provider: "serv",
      outcome: "ok",
      promptTokens: 300,
      completionTokens: 60,
      sketchOk: true,
      extractOutcome: "ok",
      extractPromptTokens: 250,
      extractCompletionTokens: 70,
    });

    // What the dock shows: watch lit, decide waiting on "how", tell you not yet.
    const dock = sketchFromDTO(t.sketch!.sketch);
    expect(nodesOf(dock)).toEqual({ watch: "on", decide: "ask", tell: "off" });
    expect(statusLine(dock, false)).toBe("Waiting on one answer from you");
  });

  it("merges the next sketch: new values land, empty ones keep what was stored", async () => {
    nextReply = ["Every 5 minutes it is. Where should it tell you?"];
    nextSketch = extraction({ how: "every 5 minutes", asking: "tells", choices: ["Telegram", "Email"] });
    const t = await turn("Every 5 minutes", convo);

    // The reply knew what the sketch held.
    expect(calls.at(-2)!.messages[0]!.content).toContain(
      "Known so far: name ETH floor watch, kind watcher, watches ETH price, when below $2,000; missing: how, tells.",
    );
    expect(t.sketch?.sketch).toMatchObject({ name: "ETH floor watch", watches: "ETH price", when: "below $2,000", how: "every 5 minutes", asking: "tells" });
    expect(nodesOf(sketchFromDTO(t.sketch!.sketch))).toEqual({ watch: "on", decide: "on", tell: "ask" });
  });

  it("keeps the reply and the stored sketch when the extraction does not validate or fails", async () => {
    nextReply = ["Telegram works. Anything else?"];
    nextSketch = '{"name": "broken",';
    const bad = await turn("Telegram", convo);
    expect(bad.shown).toBe("Telegram works. Anything else?");
    expect(bad.sketch).toBeUndefined();
    expect(bad.events.at(-1)?.event).toBe("done");

    nextSketch = 500;
    const failed = await turn("Telegram, I said", convo);
    expect(failed.sketch).toBeUndefined();
    expect(failed.events.at(-1)?.event).toBe("done");

    expect(await sketchRow(convo)).toMatchObject({ name: "ETH floor watch", how: "every 5 minutes", tells: null });
    const usage = await state.db.select().from(schema.replyUsage).orderBy(schema.replyUsage.createdAt);
    expect(usage.map((u) => [u.sketchOk, u.extractOutcome])).toEqual([
      [true, "ok"],
      [true, "ok"],
      [false, "ok"],
      [false, "failed"],
    ]);
  });

  it("still keeps an old sketch block or bare sketch JSON in a reply off the screen", async () => {
    const block = '{"name":"ETH floor watch","tells":"Telegram"}';
    nextReply = ["Telegram it is.\n\n<<<SK", `ETCH\n${block}\nSKETCH>>>`];
    nextSketch = extraction({ tells: "Telegram" });
    const marked = await turn("Use Telegram", convo);
    expect(marked.shown).toBe("Telegram it is.\n\n");

    nextReply = ["All set.\n", JSON.stringify(JSON.parse(block), null, 2)];
    const bare = await turn("Thanks", convo);
    expect(bare.shown).toBe("All set.\n");
    expect(statusLine(sketchFromDTO(bare.sketch!.sketch), false)).toBe("Ready. Switching on comes in the next update.");
  });
});
