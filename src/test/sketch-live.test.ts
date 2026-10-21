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
// Each turn is two calls (the reply, max_tokens 400, then the extraction,
// max_tokens 200) through the real /api/chat route, on an in-memory Postgres
// with sign-in stubbed. A guard refuses any SERV call past LIVE_BUDGET (9).
// Everything each turn returned is written, unfiltered, to LIVE_REPORT.
// Runs only with RUN_SKETCH_LIVE=1 and SERV_API_KEY in the environment.
const enabled = process.env.RUN_SKETCH_LIVE === "1" && Boolean(process.env.SERV_API_KEY);
const BUDGET = Number(process.env.LIVE_BUDGET ?? 9);

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

const PROMPTS = [
  "Tell me when ETH drops below $2,000",
  "Send me the three biggest AI stories every morning",
  "A Telegram bot that answers questions about my shop",
];

interface TurnReport {
  said: string;
  reply: string;
  events: string[];
  sketch: unknown;
  replyEndToSketchMs: number | null;
  usage: unknown;
}

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let servCalls = 0;
const turns: TurnReport[] = [];

async function turn(said: string, conversationId?: string): Promise<TurnReport & { conversationId: string }> {
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
  let replyEnd: number | null = null;
  let sketchAt: number | null = null;
  let sketch: unknown = null;
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
      if (event === "delta") reply += data.text;
      if (event === "reply_end") replyEnd = Date.now();
      if (event === "sketch") {
        sketchAt = Date.now();
        sketch = data;
      }
      if (event === "error") reply += `[error event] ${data.message}`;
    }
  }
  const usage = (await db.select().from(schema.replyUsage).orderBy(asc(schema.replyUsage.createdAt))).at(-1);
  const report = { said, reply, events, sketch, replyEndToSketchMs: replyEnd && sketchAt ? sketchAt - replyEnd : null, usage };
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
  [state.user] = await db.insert(schema.users).values({ privyUserId: "did:privy:live", email: "live@example.com" }).returning();
  vi.stubEnv("CHAT_MAX_TOKENS", "400");
  vi.stubEnv("SKETCH_MAX_TOKENS", "200");
  vi.stubEnv("FALLBACK_API_KEY", "");
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("inference-api.openserv.ai")) {
      servCalls += 1;
      if (servCalls > BUDGET) return Promise.reject(new Error(`live budget of ${BUDGET} SERV calls reached`));
    }
    return real(input, init);
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
  it("fills in over the three examples and one answer", async () => {
    const first = [];
    for (const said of PROMPTS) first.push(await turn(said));
    // Answer the ETH watcher's question.
    await turn("Telegram", first[0]!.conversationId);
    expect(turns).toHaveLength(4);
  }, 180_000);
});
