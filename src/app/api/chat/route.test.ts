// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { desc, eq } from "drizzle-orm";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { nodesOf, sketchFromDTO, statusLine } from "@/lib/agentSketch";
import type { SketchDTO } from "@/lib/types";
import { POST } from "./route";

// Whole chat turns through the real /api/chat route: the real migrations run
// on an in-memory Postgres, sign-in is stubbed, and SERV is a mocked fetch
// that answers the plan call and then streams the reply.

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
// What the next turn's two calls answer: the plan's JSON text (or an HTTP
// status for a failed plan), then the reply's chunks.
let nextReply: string[] | number = [];
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
  sketch: { conversationId: string; sketch: SketchDTO } | undefined;
  // The buttons, which come with reply_end.
  choices: string[] | undefined;
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
    choices: events.find((e) => e.event === "reply_end")?.data.choices as string[] | undefined,
    conversationId: events.find((e) => e.event === "meta" || e.event === "sketch")!.data.conversationId as string,
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
  [state.user] = await state.db.insert(schema.users).values({ privyUserId: "did:privy:test", email: "maya@example.com", handle: "maya", access: "approved" }).returning();
  vi.stubEnv("SERV_API_KEY", "test-serv-key");
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    calls.push(body);
    if (!body.stream) return servJson(nextSketch);
    return typeof nextReply === "number" ? new Response("{}", { status: nextReply }) : servStream(nextReply);
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await client.close();
});

describe("a chat turn with a sketch", () => {
  let convo = "";

  it("plans the turn, saves the sketch, then streams the reply that asks the planned question", async () => {
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

    expect(t.events.map((e) => e.event).filter((e, i, all) => e !== "delta" || all[i - 1] !== "delta")).toEqual(["sketch", "meta", "delta", "reply_end", "done"]);
    expect(t.shown).toBe(reply);
    // reply_end comes once the reply is saved, so it already names the message.
    const ids = t.events.filter((e) => e.event === "reply_end" || e.event === "done").map((e) => e.data.messageId);
    expect(ids[0]).toBeTruthy();
    expect(ids).toEqual([ids[0], ids[0]]);
    // The sketch lands before the reply's first word; the buttons come only
    // with reply_end, after the last one.
    const names = t.events.map((e) => e.event);
    expect(names.indexOf("sketch")).toBeLessThan(names.indexOf("delta"));
    expect(t.events.filter((e) => "choices" in e.data).map((e) => e.event)).toEqual(["reply_end"]);
    expect(names.lastIndexOf("delta")).toBeLessThan(names.indexOf("reply_end"));
    expect(t.choices).toEqual(["Every minute", "Every 5 minutes", "Every hour"]);
    expect(t.sketch?.sketch).toEqual({
      name: "ETH floor watch",
      kind: "watcher",
      watches: "ETH price",
      when: "below $2,000",
      how: null,
      tells: null,
      takes: null,
      does: null,
      gives: null,
      wakes: null,
      looks: null,
      handles: null,
      finish: null,
      asks: null,
      setup: null,
      remembers: null,
      asking: "how",
      live: false,
      kindChosen: false,
    });

    // Two calls: the strict JSON plan, then the streamed reply, which knows
    // the planned sketch and asks the planned question.
    const [planCall, replyCall] = calls.slice(-2);
    expect(planCall).toMatchObject({ stream: false, response_format: { type: "json_schema", json_schema: { name: "agent_sketch", strict: true } } });
    expect(planCall!.messages[1]!.content).toContain("Person: Tell me when ETH drops below $2,000");
    expect(planCall!.messages[1]!.content).not.toContain("Last reply");
    expect(replyCall).toMatchObject({ stream: true });
    expect(replyCall!.messages[0]!.content).toContain("Known so far: name ETH floor watch, kind watcher, watches ETH price, when below $2,000; missing: how, tells.");
    // It is told the planned field and the exact buttons.
    expect(replyCall!.messages[0]!.content).toContain(
      'Ask about: how (how often it checks). The user will see these buttons: "Every minute", "Every 5 minutes", "Every hour". Your question must fit them.',
    );

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

    // The plan saw only the stored sketch, the reply being answered and the
    // new message: nothing older from the history.
    const planCall = calls.at(-2)!;
    expect(planCall.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(planCall.messages[1]!.content).toBe(
      'Sketch: {"name":"ETH floor watch","kind":"watcher","watches":"ETH price","when":"below $2,000"}\n' +
        "Last reply: Good one. How often should it check the price?\n" +
        "Person: Every 5 minutes",
    );

    // The reply knew what the sketch held, with this turn's answer in it.
    expect(calls.at(-1)!.messages[0]!.content).toContain(
      "Known so far: name ETH floor watch, kind watcher, watches ETH price, when below $2,000, how every 5 minutes; missing: tells.",
    );
    expect(t.sketch?.sketch).toMatchObject({ name: "ETH floor watch", watches: "ETH price", when: "below $2,000", how: "every 5 minutes", asking: "tells" });
    expect(nodesOf(sketchFromDTO(t.sketch!.sketch))).toEqual({ watch: "on", decide: "on", tell: "ask" });
  });

  it("still replies, with no buttons, when the plan does not validate or fails", async () => {
    nextReply = ["Telegram works. Anything else?"];
    nextSketch = '{"name": "broken",';
    const bad = await turn("Telegram", convo);
    expect(bad.shown).toBe("Telegram works. Anything else?");
    expect(bad.sketch).toBeUndefined();
    expect(bad.choices).toEqual([]);
    expect(bad.events.map((e) => e.event)).toEqual(["meta", "delta", "reply_end", "done"]);
    // The reply ran on the stored sketch and chose its own question.
    const prompt = calls.at(-1)!.messages[0]!.content;
    expect(prompt).toContain("Known so far: name ETH floor watch, kind watcher, watches ETH price, when below $2,000, how every 5 minutes; missing: tells.");
    expect(prompt).toContain("Ask about the most important missing piece.");
    expect(prompt).not.toContain("buttons");

    nextSketch = 500;
    const failed = await turn("Telegram, I said", convo);
    expect(failed.shown).toBe("Telegram works. Anything else?");
    expect(failed.sketch).toBeUndefined();
    expect(failed.choices).toEqual([]);
    expect(failed.events.at(-1)?.event).toBe("done");
    // Still only the last reply and the new message, however long the chat.
    expect(calls.at(-2)!.messages[1]!.content).not.toContain("Tell me when ETH");

    expect(await sketchRow(convo)).toMatchObject({ name: "ETH floor watch", how: "every 5 minutes", tells: null });
    const usage = await state.db.select().from(schema.replyUsage).orderBy(schema.replyUsage.createdAt);
    expect(usage.map((u) => [u.sketchOk, u.extractOutcome])).toEqual([
      [true, "ok"],
      [true, "ok"],
      [false, "ok"],
      [false, "failed"],
    ]);
  });

  it("keeps a valid plan's sketch when the reply then fails", async () => {
    const other = await turn("Ping me when gas is cheap");
    nextReply = 402;
    nextSketch = extraction({ name: "Gas watch", kind: "watcher", watches: "gas price", asking: "when", choices: ["Under 10 gwei"] });
    const t = await turn("Watch gas instead", other.conversationId);
    expect(t.events.map((e) => e.event)).toEqual(["sketch", "error"]);
    expect(t.choices).toBeUndefined();
    expect(await sketchRow(other.conversationId)).toMatchObject({ name: "Gas watch", watches: "gas price", asking: "when" });
    const [usage] = await state.db.select().from(schema.replyUsage).orderBy(desc(schema.replyUsage.createdAt)).limit(1);
    expect(usage).toMatchObject({ outcome: "failed", sketchOk: true, extractOutcome: "ok" });
  });

  it("still keeps an old sketch block or bare sketch JSON in a reply off the screen", async () => {
    const block = '{"name":"ETH floor watch","tells":"Telegram"}';
    nextReply = ["Telegram it is.\n\n<<<SK", `ETCH\n${block}\nSKETCH>>>`];
    nextSketch = extraction({ tells: "Telegram" });
    const marked = await turn("Use Telegram", convo);
    expect(marked.shown).toBe("Telegram it is.\n\n");

    // Every field known and nothing to ask: the reply confirms, with no buttons.
    nextReply = ["All set.\n", JSON.stringify(JSON.parse(block), null, 2)];
    nextSketch = extraction({ tells: "Telegram", choices: ["Yes"] });
    const bare = await turn("Thanks", convo);
    expect(bare.shown).toBe("All set.\n");
    expect(bare.choices).toEqual([]);
    expect(calls.at(-1)!.messages[0]!.content).toContain("The agent is fully described: confirm that, say switching it on comes in the next update, and ask nothing.");
    expect(statusLine(sketchFromDTO(bare.sketch!.sketch), false)).toBe("Ready. Switching on comes in the next update.");
  });
});

describe("an agent's interview", () => {
  it("is planned as an agent when it runs on its own, and asks its questions one at a time with buttons", async () => {
    nextReply = ["Where does it look for your stock?"];
    nextSketch = extraction({
      name: "Fabric restock",
      kind: "agent",
      wakes: "every morning at eight",
      handles: "orders what is low",
      asking: "looks",
      choices: ["A Google sheet", "My shop's website"],
    });
    const t = await turn("Every morning, check my fabric stock and reorder what's low");
    expect(t.sketch?.sketch).toMatchObject({ kind: "agent", wakes: "every morning at eight", handles: "orders what is low", asking: "looks" });
    expect(t.choices).toEqual(["A Google sheet", "My shop's website"]);
    const reply = calls.at(-1)!;
    expect(reply.messages[0]!.content).toContain("Known so far: name Fabric restock, kind agent, wakes every morning at eight, handles orders what is low; missing: looks, finish, asks, setup, remembers.");
    expect(reply.messages[0]!.content).toContain('Ask about: looks (where it looks). The user will see these buttons: "A Google sheet", "My shop\'s website".');
    expect(await sketchRow(t.conversationId)).toMatchObject({ kind: "agent", wakes: "every morning at eight", looks: null });

    // With the interview complete, the reply points at the Plan button.
    nextReply = ["Got it, ready to plan."];
    nextSketch = extraction({ looks: "the Stock sheet", finish: "an order is recorded", asks: "orders over 250 USDC", setup: "the sheets", remembers: "the last order" });
    await turn("The Stock sheet; done once an order is recorded; ask over 250 USDC; it needs the sheets; remember the last order", t.conversationId);
    expect(calls.at(-1)!.messages[0]!.content).toContain("say the Plan button on the sketch turns it into steps to test");
  });
});
