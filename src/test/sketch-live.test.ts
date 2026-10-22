// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { asc } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { POST } from "@/app/api/chat/route";

// A live check of the whole turn against the real SERV model: the three
// example prompts from the empty state, then one answer on the ETH watcher.
// Each turn is two calls (the plan, max_tokens 200, then the reply,
// max_tokens 400) through the real /api/chat route, on an in-memory Postgres
// with sign-in stubbed. A guard refuses any SERV call past LIVE_BUDGET (10).
// Everything each turn sent and got back is written, unfiltered, to
// LIVE_REPORT: both request bodies (the key travels in a header and is not
// kept), the plan's raw JSON, every event and the usage row.
// Runs only with RUN_SKETCH_LIVE=1 and SERV_API_KEY in the environment.
const enabled = process.env.RUN_SKETCH_LIVE === "1" && Boolean(process.env.SERV_API_KEY);
const BUDGET = Number(process.env.LIVE_BUDGET ?? 10);

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

const PROMPTS = [
  "Tell me when ETH drops below $2,000",
  "Send me the three biggest AI stories every morning",
  "A Telegram bot that answers questions about my shop",
];

interface ServCall {
  request: unknown;
  // The plan's whole response body; the reply's is the streamed text below.
  response?: unknown;
}

interface TurnReport {
  said: string;
  calls: ServCall[];
  events: string[];
  sketch: unknown;
  reply: string;
  choices: unknown;
  msToSketch: number | null;
  msToFirstReplyToken: number | null;
  usage: unknown;
}

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let servCalls = 0;
let current: ServCall[] = [];
const turns: TurnReport[] = [];

async function turn(said: string, conversationId?: string): Promise<TurnReport & { conversationId: string }> {
  current = [];
  const started = Date.now();
  const res = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: said, conversationId }),
    }),
  );
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let reply = "";
  let firstToken: number | null = null;
  let sketchAt: number | null = null;
  let sketch: unknown = null;
  let choices: unknown = null;
  let cid = conversationId ?? "";
  const events: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const event = /event: (.*)/.exec(f)?.[1] ?? "";
      const data = JSON.parse(/data: (.*)/.exec(f)?.[1] ?? "null");
      if (event !== "delta" || events.at(-1) !== "delta") events.push(event);
      if (event === "meta") cid = data.conversationId;
      if (event === "delta") {
        firstToken ??= Date.now() - started;
        reply += data.text;
      }
      if (event === "sketch") {
        sketchAt = Date.now() - started;
        sketch = data;
        cid = data.conversationId;
      }
      if (event === "reply_end") choices = data.choices;
      if (event === "error") reply += `[error event] ${data.message}`;
    }
  }
  const usage = (await db.select().from(schema.replyUsage).orderBy(asc(schema.replyUsage.createdAt))).at(-1);
  const report = { said, calls: current, events, sketch, reply, choices, msToSketch: sketchAt, msToFirstReplyToken: firstToken, usage };
  turns.push(report);
  console.log(`\n[live turn ${turns.length}]\n${JSON.stringify(report, null, 2)}\n`);
  return { ...report, conversationId: cid };
}

beforeAll(async () => {
  if (!enabled) return;
  client = new PGlite();
  db = drizzle(client, { schema });
  state.db = db;
  await migrate(db, { migrationsFolder: join(__dirname, "../lib/db/migrations") });
  [state.user] = await db.insert(schema.users).values({ privyUserId: "did:privy:live", email: "live@example.com", handle: "live" }).returning();
  vi.stubEnv("CHAT_MAX_TOKENS", "400");
  vi.stubEnv("SKETCH_MAX_TOKENS", "200");
  vi.stubEnv("FALLBACK_API_KEY", "");
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("inference-api.openserv.ai")) return real(input, init);
    servCalls += 1;
    if (servCalls > BUDGET) throw new Error(`live budget of ${BUDGET} SERV calls reached`);
    const request = JSON.parse(String(init?.body));
    const call: ServCall = { request };
    current.push(call);
    const res = await real(input, init);
    if (!request.stream) call.response = await res.clone().json().catch(() => `status ${res.status}`);
    return res;
  });
});

afterAll(async () => {
  if (!enabled) return;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const out = process.env.LIVE_REPORT;
  if (out) writeFileSync(out, JSON.stringify({ servCalls, turns }, null, 2));
  console.log(`\n[live] SERV calls used: ${servCalls}`);
  await client.close();
});

describe.runIf(enabled)("the sketch, live", () => {
  it("plans and replies over the three examples and one answer", async () => {
    const first = [];
    for (const said of PROMPTS) first.push(await turn(said));
    // Answer the ETH watcher's question.
    await turn("Telegram", first[0]!.conversationId);
    expect(turns).toHaveLength(4);
  }, 180_000);
});
