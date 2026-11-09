// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { desc, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import * as schema from "@/lib/db/schema";
import { addHelper, addUser, testDb } from "@/test/helperDb";
import { FakeChain } from "@/test/fakeChain";
import { decryptSecret } from "@/lib/crypto";
import { DOLPHIN_BASE_URL, DOLPHIN_MODEL, SERV_BASE_URL } from "@/lib/model";
import { resetPaymentsConfig } from "@/lib/payments/config";
import { setChainClient } from "@/lib/payments/chain";
import { chatQuota, refusal, spendToday } from "@/lib/spend";
import { LIMIT_MESSAGE } from "@/lib/limits";
import { POST as chat } from "./chat/route";
import { GET as account } from "./account/route";
import { DELETE as dropKey, POST as saveKey } from "./account/serv-key/route";
import { POST as publish } from "./helpers/route";
import { POST as use } from "./helpers/[slug]/use/route";
import { GET as messagesOf } from "./conversations/[id]/messages/route";
import { DELETE as deleteConversation } from "./conversations/[id]/route";
import { PATCH as setKind } from "./conversations/[id]/sketch/route";
import { GET as admin } from "./admin/route";
import { POST as decideAccess } from "./admin/access/[id]/route";

// Phase 0's protections through the real routes, on an in-memory Postgres
// with the real migrations: the daily message limit, the site's spend
// limit, own SERV keys, invite-only, Dolphin's place in the order, plain
// errors, em dashes and the kind switch. Every model is a mocked fetch that
// records where each call went and with which key. Nothing leaves the machine.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

const EM = String.fromCharCode(0x2014);
const OWN_KEY = `sk-own-${randomBytes(16).toString("hex")}`;
const PROMPT = "You turn a product name and a few facts into a friendly two line shop blurb. Refuse anything else.";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let ana: schema.User;
let ben: schema.User;

interface Call {
  url: string;
  auth: string;
  body: { model: string; stream: boolean; max_tokens: number; messages: { role: string; content: string }[]; stream_options?: unknown; response_format?: { json_schema?: { name?: string } } };
}
const calls: Call[] = [];
// What each provider answers: a status other than 200 refuses, or throws for
// a network error. Streams send these chunks, then usage.
let status: { serv: number | "down"; dolphin: number } = { serv: 200, dolphin: 200 };
let chunks: string[] = [];
let sketchJson = "";

function stream(parts: string[]): Response {
  const enc = new TextEncoder();
  const frame = (d: unknown) => enc.encode(`data: ${JSON.stringify(d)}\n\n`);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const content of parts) c.enqueue(frame({ choices: [{ index: 0, delta: { content } }] }));
        c.enqueue(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const plan = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "Shop blurbs", kind: "none", watches: "", when: "", how: "", tells: "", takes: "", does: "", gives: "", asking: "none", choices: [], ...o });

async function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  const call: Call = { url, auth: (init.headers as Record<string, string>).authorization ?? "", body: JSON.parse(String(init.body)) as Call["body"] };
  calls.push(call);
  const s = url.startsWith(SERV_BASE_URL) ? status.serv : url.startsWith(DOLPHIN_BASE_URL) ? status.dolphin : 200;
  if (s === "down") throw new TypeError("fetch failed");
  if (s !== 200) return new Response("{}", { status: s });
  if (!call.body.stream) {
    const name = call.body.response_format?.json_schema?.name;
    const content = name === "helper_prompt" ? JSON.stringify({ prompt: PROMPT }) : name === "agent_sketch" ? sketchJson : "Hi";
    return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 200, completion_tokens: 50 } });
  }
  return stream(chunks);
}

const json = (url: string, method: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

interface Turn {
  status: number;
  body: string;
  events: { event: string; data: Record<string, unknown> }[];
  shown: string;
}

function read(status: number, body: string, sse: boolean): Turn {
  const events = sse
    ? body
        .split("\n\n")
        .filter(Boolean)
        .map((f) => ({ event: /event: (.*)/.exec(f)![1]!, data: JSON.parse(/data: (.*)/.exec(f)![1]!) as Record<string, unknown> }))
    : [];
  return { status, body, events, shown: events.filter((e) => e.event === "delta").map((e) => e.data.text).join("") };
}

async function say(content: string, conversationId?: string): Promise<Turn> {
  const res = await chat(json("/api/chat", "POST", { content, conversationId }));
  return read(res.status, await res.text(), Boolean(res.headers.get("content-type")?.startsWith("text/event-stream")));
}

async function ask(slug: string, input = "The Alder mug"): Promise<Turn> {
  const res = await use(json(`/api/helpers/${slug}/use`, "POST", { input }), { params: { slug } });
  return read(res.status, await res.text(), Boolean(res.headers.get("content-type")?.startsWith("text/event-stream")));
}

async function me(): Promise<Record<string, unknown>> {
  return (await (await account(json("/api/account", "GET"))).json()) as Record<string, unknown>;
}

const conversationOf = (t: Turn) => t.events.find((e) => e.event === "meta" || e.event === "sketch")!.data.conversationId as string;

async function answerSketch(user: schema.User): Promise<string> {
  const [convo] = await db.insert(schema.conversations).values({ userId: user.id, title: "Blurbs" }).returning();
  await db.insert(schema.messages).values([
    { conversationId: convo!.id, role: "user", content: "Blurbs for my shop" },
    { conversationId: convo!.id, role: "assistant", content: "Got it." },
  ]);
  await db.insert(schema.agentSketches).values({ conversationId: convo!.id, name: "Shop blurbs", kind: "answer", takes: "a product", does: "writes a blurb", gives: "the blurb" });
  return convo!.id;
}

// Seeded usage at a given time, priced at the defaults (SERV 1.25 / 6.50,
// Dolphin 0.01 / 0.07 dollars per million tokens).
async function usageAt(at: Date, o: Partial<typeof schema.replyUsage.$inferInsert> = {}) {
  await db.insert(schema.replyUsage).values({ userId: ana.id, provider: "serv", model: "claude-haiku-4.5", promptTokens: 0, completionTokens: 0, totalMs: 1, outcome: "ok", createdAt: at, ...o });
}

const logged: string[] = [];

// Sign-in reads the user afresh on every request; the stub has to be told.
async function signedIn(user: schema.User): Promise<schema.User> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
  state.user = row!;
  return row!;
}

async function useOwnKey(): Promise<void> {
  expect((await saveKey(json("/api/account/serv-key", "POST", { key: OWN_KEY }))).status).toBe(200);
  await signedIn(ana);
}

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubGlobal("fetch", fakeFetch);
  for (const level of ["error", "info"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
});

beforeEach(async () => {
  await client.exec(
    "delete from helper_uses; delete from reply_usage; delete from helper_prices; delete from published_helpers; delete from agent_sketches; delete from messages; delete from conversations; delete from users;",
  );
  ana = await addUser(db, "ana");
  ben = await addUser(db, "ben");
  state.user = ana;
  calls.length = 0;
  logged.length = 0;
  status = { serv: 200, dolphin: 200 };
  chunks = ["Noted. What should it refuse?"];
  sketchJson = plan();
  vi.stubEnv("SERV_API_KEY", "test-serv-key");
  vi.stubEnv("DOLPHIN_API_KEY", "");
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubEnv("OPENSERV_KEY_ENC_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("INVITE_ONLY", "");
  vi.stubEnv("ADMIN_USER_IDS", "");
  vi.stubEnv("CHAT_DAILY_LIMIT", "");
  vi.stubEnv("DAILY_SPEND_LIMIT_USD", "");
  vi.stubEnv("SERV_PRICE_INPUT_PER_M", "");
  resetPaymentsConfig();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPaymentsConfig();
  setChainClient(null);
  await client.close();
});

describe("the daily message limit", () => {
  it("allows CHAT_DAILY_LIMIT messages, then refuses the next before anything is stored", async () => {
    vi.stubEnv("CHAT_DAILY_LIMIT", "2");
    const first = await say("Blurbs for my shop");
    expect(first.status).toBe(200);
    const cid = conversationOf(first);
    expect((await me()).chat).toMatchObject({ limit: 2, remaining: 1 });
    expect((await say("Warm, never pushy", cid)).status).toBe(200);

    const stored = await db.select().from(schema.messages);
    const before = calls.length;
    const refused = await say("One more", cid);
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toEqual({
      error: "You've used today's 2 messages. They reset at midnight UTC.",
      limit: "chat",
      quota: { limit: 2, remaining: 0, resetsAt: expect.any(String) },
    });
    // Nothing was stored and no model was asked.
    expect(await db.select().from(schema.messages)).toEqual(stored);
    expect(calls.length).toBe(before);
    expect((await me()).chat).toMatchObject({ remaining: 0 });
  });

  it("counts every turn for the person, keeps counting after a conversation is deleted, and not a failed turn", async () => {
    vi.stubEnv("CHAT_DAILY_LIMIT", "3");
    const t = await say("Blurbs for my shop");
    await deleteConversation(json(`/api/conversations/${conversationOf(t)}`, "DELETE"), { params: { id: conversationOf(t) } });
    expect((await me()).chat).toMatchObject({ remaining: 2 });

    status.serv = 500;
    const failed = await say("Again");
    expect(failed.events.at(-1)!.event).toBe("error");
    expect((await me()).chat).toMatchObject({ remaining: 2 });

    // Someone else has all of theirs.
    state.user = ben;
    expect((await me()).chat).toMatchObject({ remaining: 3 });
  });

  it("starts again at midnight UTC", async () => {
    vi.stubEnv("CHAT_DAILY_LIMIT", "2");
    await usageAt(new Date("2026-11-08T09:00:00Z"));
    await usageAt(new Date("2026-11-08T23:59:00Z"));
    expect(await chatQuota(ana.id, new Date("2026-11-08T23:59:59Z"))).toEqual({ limit: 2, remaining: 0, resetsAt: "2026-11-09T00:00:00.000Z" });
    expect(await refusal(ana.id, { ownKey: false, chat: true, now: new Date("2026-11-08T23:59:59Z") })).toMatchObject({ limit: "chat" });
    expect(await chatQuota(ana.id, new Date("2026-11-09T00:00:01Z"))).toEqual({ limit: 2, remaining: 2, resetsAt: "2026-11-10T00:00:00.000Z" });
    expect(await refusal(ana.id, { ownKey: false, chat: true, now: new Date("2026-11-09T00:00:01Z") })).toBeNull();
  });
});

describe("the site's daily spend limit", () => {
  it("adds up today's replies, plan calls, compile calls and helper uses at each model's price, without own-key use", async () => {
    const day = new Date("2026-11-08T12:00:00Z");
    // 1M tokens in on SERV: $1.25. A plan on Dolphin, 1M out: $0.07.
    await usageAt(day, { promptTokens: 1_000_000, extractProvider: "dolphin", extractCompletionTokens: 1_000_000 });
    // An older plan with no provider kept was SERV: 1M out, $6.50.
    await usageAt(day, { provider: "dolphin", extractCompletionTokens: 1_000_000 });
    // A compile call on SERV, 2M in: $2.50.
    await usageAt(day, { kind: "compile", promptTokens: 2_000_000 });
    // A helper use, 1M out, no provider kept (SERV): $6.50.
    await db.insert(schema.helperUses).values({ userId: ana.id, completionTokens: 1_000_000, latencyMs: 1, outcome: "ok", createdAt: day });
    // Not counted: own-key use, the demo, and yesterday.
    await usageAt(day, { ownKey: true, promptTokens: 9_000_000 });
    await db.insert(schema.helperUses).values({ userId: ana.id, ownKey: true, completionTokens: 9_000_000, latencyMs: 1, outcome: "ok", createdAt: day });
    await usageAt(day, { provider: "demo", promptTokens: 9_000_000 });
    await usageAt(new Date("2026-11-07T23:59:59Z"), { promptTokens: 9_000_000 });

    expect(await spendToday(day)).toBeCloseTo(1.25 + 0.07 + 6.5 + 2.5 + 6.5, 6);
    // Prices come from the environment.
    vi.stubEnv("SERV_PRICE_INPUT_PER_M", "2");
    expect(await spendToday(day)).toBeCloseTo(2 + 0.07 + 6.5 + 4 + 6.5, 6);
    // A new day starts at nothing.
    expect(await spendToday(new Date("2026-11-09T00:00:01Z"))).toBe(0);
  });

  it("pauses chat, publishing and helper uses for everyone once today's estimate reaches DAILY_SPEND_LIMIT_USD", async () => {
    const cid = await answerSketch(ana);
    await addHelper(db, ana, { slug: "shop-blurbs" });
    vi.stubEnv("DAILY_SPEND_LIMIT_USD", "1");
    await usageAt(new Date(), { promptTokens: 800_000 }); // $1.00
    const before = calls.length;
    const stored = await db.select().from(schema.messages);

    const refused = await say("Blurbs");
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toEqual({ error: LIMIT_MESSAGE, limit: "site" });
    expect(LIMIT_MESSAGE).toBe("boardofserv has hit today's limit. It resets at midnight UTC.");
    const used = await ask("shop-blurbs");
    expect(used.status).toBe(429);
    expect(JSON.parse(used.body).error).toBe(LIMIT_MESSAGE);
    const published = await publish(json("/api/helpers", "POST", { conversationId: cid, description: "Blurbs", inputHint: "A product" }));
    expect(published.status).toBe(429);
    expect(calls.length).toBe(before);
    expect(await db.select().from(schema.messages)).toEqual(stored);
    expect(await me()).toMatchObject({ paused: true });

    // Not before the limit: just under it, chat runs.
    vi.stubEnv("DAILY_SPEND_LIMIT_USD", "1.01");
    expect((await say("Blurbs")).status).toBe(200);
  });

  it("starts again at midnight UTC", async () => {
    vi.stubEnv("DAILY_SPEND_LIMIT_USD", "1");
    await usageAt(new Date("2026-11-08T22:00:00Z"), { promptTokens: 1_000_000 });
    expect(await refusal(ana.id, { ownKey: false, now: new Date("2026-11-08T23:59:59Z") })).toEqual({ error: LIMIT_MESSAGE, limit: "site" });
    expect(await refusal(ana.id, { ownKey: false, now: new Date("2026-11-09T00:00:00Z") })).toBeNull();
  });

  it("shows today's spend against the limit on /admin", async () => {
    vi.stubEnv("ADMIN_USER_IDS", ana.id);
    vi.stubEnv("DAILY_SPEND_LIMIT_USD", "2");
    resetPaymentsConfig();
    setChainClient(new FakeChain());
    await usageAt(new Date(), { promptTokens: 200_000 }); // $0.25
    const body = await (await admin(json("/api/admin", "GET"))).json();
    expect(body.admin.spend).toEqual({ today: 0.25, limit: 2, resetsAt: expect.stringMatching(/T00:00:00.000Z$/) });
  });
});

describe("your own SERV key", () => {
  it("is checked with one tiny call on its own credit, kept encrypted and shown as its last four characters", async () => {
    const res = await saveKey(json("/api/account/serv-key", "POST", { key: ` ${OWN_KEY} ` }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ servKey: { last4: OWN_KEY.slice(-4) } });
    expect(text).not.toContain(OWN_KEY.slice(0, 12));

    // One call to SERV, on the key itself, asking for a single token.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${SERV_BASE_URL}/chat/completions`, auth: `Bearer ${OWN_KEY}`, body: { max_tokens: 1, stream: false } });
    expect(calls[0]!.body.messages[0]!.role).toBe("system");

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, ana.id));
    expect(row!.servKeyEncrypted).not.toContain(OWN_KEY);
    expect(decryptSecret(row!.servKeyEncrypted!)).toBe(OWN_KEY);
    expect(row!.servKeyLast4).toBe(OWN_KEY.slice(-4));
    await signedIn(ana);
    const mine = await me();
    expect(mine.servKey).toEqual({ last4: OWN_KEY.slice(-4) });
    expect(JSON.stringify(mine)).not.toContain(OWN_KEY.slice(0, 12));

    // Removable.
    expect(await (await dropKey(json("/api/account/serv-key", "DELETE"))).json()).toEqual({ servKey: null });
    const [gone] = await db.select().from(schema.users).where(eq(schema.users.id, ana.id));
    expect(gone).toMatchObject({ servKeyEncrypted: null, servKeyLast4: null });
    await signedIn(ana);
    expect((await me()).servKey).toBeNull();
  });

  it("turns away a key SERV refuses, one with no credit, and one that couldn't be checked, keeping nothing", async () => {
    const tries: [number | "down", number, string][] = [
      [401, 400, "SERV didn't accept that key. Check it and try again."],
      [402, 400, "That key has no SERV credit left. Top it up, then add it again."],
      [500, 502, "SERV couldn't be reached to check the key. Try again in a few minutes."],
      ["down", 502, "SERV couldn't be reached to check the key. Try again in a few minutes."],
    ];
    for (const [serv, code, error] of tries) {
      status.serv = serv;
      const res = await saveKey(json("/api/account/serv-key", "POST", { key: OWN_KEY }));
      expect(res.status).toBe(code);
      expect(await res.json()).toEqual({ error });
    }
    // A key with a space in it is not sent anywhere.
    const before = calls.length;
    expect((await saveKey(json("/api/account/serv-key", "POST", { key: "two words-and-more" }))).status).toBe(400);
    expect(calls.length).toBe(before);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, ana.id));
    expect(row).toMatchObject({ servKeyEncrypted: null, servKeyLast4: null });
  });

  it("runs that person's chat, plan and helper uses on their key alone, with no daily limit and never paused", async () => {
    await useOwnKey();
    await addHelper(db, ben, { slug: "shop-blurbs" });
    vi.stubEnv("DOLPHIN_API_KEY", "test-dolphin-key");
    vi.stubEnv("CHAT_DAILY_LIMIT", "1");
    vi.stubEnv("DAILY_SPEND_LIMIT_USD", "1");
    await usageAt(new Date(), { userId: ben.id, promptTokens: 1_000_000 }); // the site is over its limit
    calls.length = 0;

    for (const words of ["Blurbs", "Warm", "Short"]) expect((await say(words)).status).toBe(200);
    expect((await ask("shop-blurbs")).status).toBe(200);
    // Every call went to SERV with their key: none on the site's keys, none to Dolphin.
    expect(calls.length).toBe(7);
    expect(calls.every((c) => c.url.startsWith(SERV_BASE_URL) && c.auth === `Bearer ${OWN_KEY}`)).toBe(true);
    const rows = await db.select().from(schema.replyUsage).where(eq(schema.replyUsage.userId, ana.id));
    expect(rows.map((r) => r.ownKey)).toEqual([true, true, true]);
    expect((await db.select().from(schema.helperUses).where(eq(schema.helperUses.userId, ana.id)))[0]).toMatchObject({ ownKey: true, provider: "serv" });
    expect(await me()).toMatchObject({ chat: null, paused: false });

    // Their use is not the site's spend: still only the seeded dollar.
    expect(await spendToday()).toBeCloseTo(1.25, 6);
    // Everyone else is still paused.
    state.user = ben;
    expect((await say("Hello")).status).toBe(429);
  });

  it("tells them in plain words when SERV refuses their key or it runs out of credit", async () => {
    await useOwnKey();
    status.serv = 402;
    expect((await say("Blurbs")).events.at(-1)!.data.message).toBe(
      "Your SERV key is out of credit. Top it up, or remove it in the account menu to go back to boardofserv's own.",
    );
    status.serv = 401;
    expect((await say("Blurbs")).events.at(-1)!.data.message).toBe("SERV didn't accept your key. Check it in the account menu.");
  });
});

describe("Dolphin's place in the order", () => {
  it("answers the chat when SERV fails, on its default model, asked for usage", async () => {
    vi.stubEnv("DOLPHIN_API_KEY", "test-dolphin-key");
    status.serv = 503;
    const t = await say("Blurbs for my shop");
    expect(t.events.find((e) => e.event === "meta")!.data).toMatchObject({ source: "dolphin", label: "Dolphin" });
    const dolphin = calls.filter((c) => c.url.startsWith(DOLPHIN_BASE_URL));
    // The plan and the reply, both on Dolphin's key.
    expect(dolphin).toHaveLength(2);
    expect(dolphin.every((c) => c.auth === "Bearer test-dolphin-key" && c.body.model === DOLPHIN_MODEL)).toBe(true);
    expect(dolphin.find((c) => c.body.stream)!.body.stream_options).toEqual({ include_usage: true });
    const [row] = await db.select().from(schema.replyUsage).orderBy(desc(schema.replyUsage.createdAt)).limit(1);
    expect(row).toMatchObject({ provider: "dolphin", model: DOLPHIN_MODEL, extractProvider: "dolphin", extractModel: DOLPHIN_MODEL, promptTokens: 1000 });
  });

  it("never answers a helper use, which stays on SERV", async () => {
    vi.stubEnv("DOLPHIN_API_KEY", "test-dolphin-key");
    await addHelper(db, ben, { slug: "shop-blurbs" });
    status.serv = 503;
    const t = await ask("shop-blurbs");
    expect(t.events.at(-1)).toMatchObject({ event: "error", data: { message: "The helper could not answer just now. Try again in a minute." } });
    expect(calls.some((c) => c.url.startsWith(DOLPHIN_BASE_URL))).toBe(false);
  });
});

describe("plain errors", () => {
  it("tells the person one plain sentence and keeps the details in the server's log", async () => {
    status.serv = 500;
    const t = await say("Blurbs for my shop");
    expect(t.events.at(-1)).toEqual({ event: "error", data: { message: "Replies aren't available right now. Try again in a few minutes." } });
    expect(t.body).not.toMatch(/\(500\)|server error|SERV_API_KEY/);
    expect(logged.some((l) => l.startsWith("chat: no reply.") && l.includes("had a server error (500)"))).toBe(true);
  });
});

describe("em dashes in model answers", () => {
  it("never reach the chat, split across chunks or not, and code keeps its own", async () => {
    chunks = [`Fast ${EM}`, ` and cheap. Pages 3${EM}5.\n\n\`\`\`\nx = "a ${EM} b"\n\`\`\`\n${EM} done`];
    const t = await say("Blurbs for my shop");
    const want = `Fast, and cheap. Pages 3-5.\n\n\`\`\`\nx = "a ${EM} b"\n\`\`\`\n- done`;
    expect(t.shown).toBe(want);
    const [reply] = await db.select().from(schema.messages).where(eq(schema.messages.role, "assistant"));
    expect(reply!.content).toBe(want);
  });

  it("never reach a helper's answer", async () => {
    await addHelper(db, ben, { slug: "shop-blurbs" });
    chunks = [`Meet the mug ${EM} `, `hand thrown.`];
    expect((await ask("shop-blurbs")).shown).toBe("Meet the mug, hand thrown.");
  });

  it("are taken out of replies stored before", async () => {
    const cid = await answerSketch(ana);
    await db.insert(schema.messages).values({ conversationId: cid, role: "assistant", content: `Sure ${EM} done.` });
    const { messages } = await (await messagesOf(json(`/api/conversations/${cid}/messages`, "GET"), { params: { id: cid } })).json();
    expect(messages.map((m: { content: string }) => m.content)).toContain("Sure, done.");
  });
});

describe("invite-only", () => {
  it("turns a waiting account away from every route that calls a model, without calling one", async () => {
    const jo = await addUser(db, "jo", "maker_2207", "waiting");
    const cid = await answerSketch(jo);
    await addHelper(db, ben, { slug: "shop-blurbs" });
    state.user = jo;
    const waiting = { error: "boardofserv is invite-only for now, and your account is on the list.", access: "waiting" };
    for (const res of [
      await chat(json("/api/chat", "POST", { content: "Hi" })),
      await use(json("/api/helpers/shop-blurbs/use", "POST", { input: "Hi" }), { params: { slug: "shop-blurbs" } }),
      await publish(json("/api/helpers", "POST", { conversationId: cid, description: "Blurbs", inputHint: "A product" })),
      await saveKey(json("/api/account/serv-key", "POST", { key: OWN_KEY })),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(waiting);
    }
    expect(calls).toHaveLength(0);
    expect((await me()).access).toBe("waiting");

    // Off, everyone is let in; an admin always is.
    vi.stubEnv("INVITE_ONLY", "0");
    expect((await me()).access).toBe("approved");
    expect((await say("Hi")).status).toBe(200);
    vi.stubEnv("INVITE_ONLY", "1");
    vi.stubEnv("ADMIN_USER_IDS", jo.privyUserId);
    resetPaymentsConfig();
    expect((await me()).access).toBe("approved");
  });

  it("lists waiting accounts for an admin, who approves or rejects each one once", async () => {
    vi.stubEnv("ADMIN_USER_IDS", ana.id);
    resetPaymentsConfig();
    setChainClient(new FakeChain());
    const jo = await addUser(db, "jo", "maker_2207", "waiting");
    const lee = await addUser(db, "lee", "maker_3301", "waiting");

    const books = await (await admin(json("/api/admin", "GET"))).json();
    expect(books.admin.access).toEqual({
      inviteOnly: true,
      waiting: [
        { id: jo.id, handle: "maker_2207", email: "jo@example.com", joinedAt: expect.any(String) },
        { id: lee.id, handle: "maker_3301", email: "lee@example.com", joinedAt: expect.any(String) },
      ],
    });

    const approve = await decideAccess(json(`/api/admin/access/${jo.id}`, "POST", { action: "approve" }), { params: { id: jo.id } });
    expect(approve.status).toBe(200);
    expect((await approve.json()).admin.access.waiting.map((u: { id: string }) => u.id)).toEqual([lee.id]);
    const reject = await decideAccess(json(`/api/admin/access/${lee.id}`, "POST", { action: "reject" }), { params: { id: lee.id } });
    expect((await reject.json()).admin.access.waiting).toEqual([]);
    const again = await decideAccess(json(`/api/admin/access/${jo.id}`, "POST", { action: "reject" }), { params: { id: jo.id } });
    expect(again.status).toBe(409);
    expect((await decideAccess(json("/api/admin/access/nope", "POST", { action: "approve" }), { params: { id: "nope" } })).status).toBe(400);

    const [joRow] = await db.select().from(schema.users).where(eq(schema.users.id, jo.id));
    expect(joRow).toMatchObject({ access: "approved", accessDecidedBy: ana.id });
    state.user = joRow;
    expect((await say("Hi")).status).toBe(200);
    const [leeRow] = await db.select().from(schema.users).where(eq(schema.users.id, lee.id));
    state.user = leeRow;
    expect((await me()).access).toBe("rejected");
    const turned = await chat(json("/api/chat", "POST", { content: "Hi" }));
    expect(turned.status).toBe(403);
    expect((await turned.json()).error).toBe("boardofserv is invite-only for now, and this account wasn't let in.");

    // Nobody else may decide, or see the list.
    state.user = ben;
    expect((await decideAccess(json(`/api/admin/access/${lee.id}`, "POST", { action: "approve" }), { params: { id: lee.id } })).status).toBe(404);
    expect((await admin(json("/api/admin", "GET"))).status).toBe(404);
  });
});

describe("the kind of a sketch", () => {
  it("is a one-shot answer helper unless the plan says otherwise", async () => {
    sketchJson = plan({ name: "Shop blurbs", kind: "none" });
    const t = await say("Blurbs for my shop");
    const [row] = await db.select().from(schema.agentSketches);
    expect(row).toMatchObject({ conversationId: conversationOf(t), kind: "answer", kindChosen: false });
  });

  it("is the maker's to switch on the dock, and the plan keeps their choice", async () => {
    const t = await say("Blurbs for my shop");
    const cid = conversationOf(t);
    await db.update(schema.agentSketches).set({ asking: "takes" }).where(eq(schema.agentSketches.conversationId, cid));
    const res = await setKind(json(`/api/conversations/${cid}/sketch`, "PATCH", { kind: "watcher" }), { params: { id: cid } });
    expect(res.status).toBe(200);
    // The question asked was an answer helper's, so it goes.
    expect((await res.json()).sketch).toMatchObject({ kind: "watcher", kindChosen: true, asking: null });

    sketchJson = plan({ kind: "answer", watches: "ETH price" });
    await say("It watches ETH", cid);
    const [row] = await db.select().from(schema.agentSketches);
    expect(row).toMatchObject({ kind: "watcher", kindChosen: true, watches: "ETH price" });

    expect((await setKind(json(`/api/conversations/${cid}/sketch`, "PATCH", { kind: "robot" }), { params: { id: cid } })).status).toBe(400);
    state.user = ben;
    expect((await setKind(json(`/api/conversations/${cid}/sketch`, "PATCH", { kind: "digest" }), { params: { id: cid } })).status).toBe(404);
  });

  it("stays put while its helper is on the board", async () => {
    const cid = await answerSketch(ana);
    expect((await publish(json("/api/helpers", "POST", { conversationId: cid, description: "Blurbs", inputHint: "A product" }))).status).toBe(200);
    const res = await setKind(json(`/api/conversations/${cid}/sketch`, "PATCH", { kind: "watcher" }), { params: { id: cid } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Take it off the board first." });
  });
});

describe("a helper's one line", () => {
  it("may be 160 characters, not 161", async () => {
    const line = "A".repeat(160);
    const ok = await publish(json("/api/helpers", "POST", { conversationId: await answerSketch(ana), description: line, inputHint: "A product" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).helper.description).toBe(line);
    const long = await publish(json("/api/helpers", "POST", { conversationId: await answerSketch(ana), description: `${line}A`, inputHint: "A product" }));
    expect(long.status).toBe(400);
  });
});
