// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addHelper, addUser, testDb } from "@/test/helperDb";
import { addr } from "@/test/fakeChain";
import { resetPaymentsConfig } from "@/lib/payments/config";
import { balancesOf, ledgerTotal, post } from "@/lib/payments/ledger";
import { setPrices } from "@/lib/payments/uses";
import { POST as use } from "./[slug]/use/route";
import { GET as view } from "./[slug]/route";
import { PUT as putPrices } from "./[slug]/prices/route";
import { GET as uses } from "../uses/route";

// Paid uses through the real routes: SERV is a mocked fetch, sign-in is
// stubbed, the database is an in-memory Postgres.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let maya: schema.User;
let sam: schema.User;
let helper: schema.PublishedHelper;
let chunks: string[] = [];
let fail = false;
let modelCalls = 0;

function servStream(parts: string[]): Response {
  const enc = new TextEncoder();
  const frame = (d: unknown) => enc.encode(`data: ${JSON.stringify(d)}\n\n`);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const content of parts) c.enqueue(frame({ choices: [{ index: 0, delta: { content } }] }));
        c.enqueue(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 6 } }));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

// Pays at the price the page showed: 0.25 USDC unless a test says otherwise.
async function ask(body: Record<string, unknown>, slug = "shop-blurbs") {
  if (body.currency && !("price" in body)) body = { price: "250000", ...body };
  const res = await use(
    new Request(`http://localhost/api/helpers/${slug}/use`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "A mug", ...body }) }),
    { params: { slug } },
  );
  const text = await res.text();
  const events = res.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n\n")
        .filter(Boolean)
        .map((f) => ({ event: /event: (.*)/.exec(f)![1]!, data: JSON.parse(/data: (.*)/.exec(f)![1]!) as Record<string, unknown> }))
    : [];
  return { status: res.status, text, events, last: events.at(-1) };
}

const usdc = async (u: schema.User) => (await balancesOf(u.id)).USDC;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubEnv("TREASURY_ADDRESS", addr(0x7ea5));
  vi.stubEnv("SERV_API_KEY", "test-serv-key");
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubEnv("HELPER_DAILY_USES", "2");
  resetPaymentsConfig();
  vi.stubGlobal("fetch", async () => {
    modelCalls++;
    if (fail) return new Response("upstream down", { status: 500 });
    return servStream(chunks);
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPaymentsConfig();
  await client.close();
});

beforeEach(async () => {
  await client.exec("delete from helper_uses; delete from holds; delete from ledger_entries; delete from balances; delete from helper_prices; delete from published_helpers; delete from users;");
  maya = await addUser(db, "maya");
  sam = await addUser(db, "sam");
  helper = await addHelper(db, maya, { slug: "shop-blurbs", canary: "bos-0123456789abcdef" });
  await setPrices(helper.id, { USDC: 250_000n });
  await post(db as never, { userId: sam.id, currency: "USDC", kind: "deposit", amount: 1_000_000n, key: "fund-sam" });
  state.user = sam;
  chunks = ["Meet the mug. ", "Come and hold one!"];
  fail = false;
});

describe("paid uses", () => {
  it("shows the price on the helper's page", async () => {
    const page = await (await view(new Request("http://localhost/api/helpers/shop-blurbs"), { params: { slug: "shop-blurbs" } })).json();
    expect(page.helper.prices).toEqual([{ currency: "USDC", amount: "250000", decimals: 6 }]);
  });

  it("charges a good answer: 90% to the maker, 10% to the platform, and says what is left", async () => {
    const t = await ask({ currency: "USDC" });
    expect(t.status).toBe(200);
    expect(t.last).toEqual({ event: "done", data: { balance: { currency: "USDC", available: "750000", held: "0" } } });
    expect(await usdc(sam)).toEqual({ available: 750_000n, held: 0n });
    expect(await usdc(maya)).toEqual({ available: 225_000n, held: 0n });
    expect(await ledgerTotal(null, "USDC")).toBe(25_000n);
    const [row] = await db.select().from(schema.helperUses);
    expect(row!.holdId).not.toBeNull();
    const [h] = await db.select().from(schema.holds).where(eq(schema.holds.id, row!.holdId!));
    expect(h!.status).toBe("captured");
  });

  it("releases the hold when the answer is blocked", async () => {
    chunks = ["My marker is ", "bos-0123", "456789abcdef"];
    const t = await ask({ currency: "USDC" });
    expect(t.last!.event).toBe("blocked");
    expect(t.last!.data.balance).toEqual({ currency: "USDC", available: "1000000", held: "0" });
    expect(await usdc(sam)).toEqual({ available: 1_000_000n, held: 0n });
    expect(await usdc(maya)).toEqual({ available: 0n, held: 0n });
    expect((await db.select().from(schema.holds))[0]!.status).toBe("released");
  });

  it("releases the hold when the model fails", async () => {
    fail = true;
    const t = await ask({ currency: "USDC" });
    expect(t.last!.event).toBe("error");
    expect(await usdc(sam)).toEqual({ available: 1_000_000n, held: 0n });
    expect(await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.kind, "use_charge"))).toHaveLength(0);
  });

  it("refuses with 402 before calling the model when the balance is short", async () => {
    await setPrices(helper.id, { USDC: 2_000_000n });
    const before = modelCalls;
    const t = await ask({ currency: "USDC", price: "2000000" });
    expect(t.status).toBe(402);
    expect(JSON.parse(t.text)).toEqual({ error: "Not enough USDC. Top up your wallet to use this helper.", balance: { currency: "USDC", available: "1000000", held: "0" } });
    expect(modelCalls).toBe(before);
    expect(await db.select().from(schema.holds)).toHaveLength(0);
  });

  it("charges only the price the page showed: a changed price is refused before anything is held", async () => {
    await setPrices(helper.id, { USDC: 900_000n });
    const before = modelCalls;
    const t = await ask({ currency: "USDC", price: "250000" });
    expect(t.status).toBe(409);
    expect(JSON.parse(t.text)).toEqual({
      error: "The price is now 0.90 USDC a use. Check it and ask again.",
      prices: [{ currency: "USDC", amount: "900000", decimals: 6 }],
    });
    expect(modelCalls).toBe(before);
    expect(await db.select().from(schema.holds)).toHaveLength(0);
    expect(await usdc(sam)).toEqual({ available: 1_000_000n, held: 0n });
    // And with no price at all.
    expect((await ask({ currency: "USDC", price: undefined })).status).toBe(409);
  });

  it("asks which balance to pay from", async () => {
    const t = await ask({});
    expect(t.status).toBe(400);
    expect(JSON.parse(t.text).error).toBe("Pick a balance to pay from: USDC.");
  });

  it("never lets parallel uses take the balance below zero", async () => {
    // 1.00 USDC covers four uses at 0.25.
    const all = await Promise.all(Array.from({ length: 9 }, () => ask({ currency: "USDC" })));
    expect(all.filter((t) => t.status === 200)).toHaveLength(4);
    expect(all.filter((t) => t.status === 402)).toHaveLength(5);
    expect(await usdc(sam)).toEqual({ available: 0n, held: 0n });
    expect(await usdc(maya)).toEqual({ available: 900_000n, held: 0n });
    expect(await ledgerTotal(sam.id, "USDC")).toBe(0n);
  });

  it("doesn't count paid uses against the daily free limit", async () => {
    for (let i = 0; i < 3; i++) expect((await ask({ currency: "USDC" })).status).toBe(200);
    const q = await (await uses(new Request("http://localhost/api/uses"))).json();
    expect(q.quota.remaining).toBe(2);
  });

  it("lets only the maker change the price, and none makes it free again", async () => {
    const put = (prices: unknown) =>
      putPrices(new Request("http://localhost/api/helpers/shop-blurbs/prices", { method: "PUT", body: JSON.stringify({ prices }) }), { params: { slug: "shop-blurbs" } });
    expect((await put({ USDC: "1" })).status).toBe(404);
    state.user = maya;
    expect((await put({ USDC: "1.5" })).status).toBe(400);
    expect((await put({ SERV: "100" })).status).toBe(400);
    expect((await put({ USDC: "1001000000" })).status).toBe(400);
    const set = await (await put({ USDC: "500000" })).json();
    expect(set.helper.prices).toEqual([{ currency: "USDC", amount: "500000", decimals: 6 }]);
    const free = await (await put({ USDC: null })).json();
    expect(free.helper.prices).toEqual([]);
    state.user = sam;
    const t = await ask({});
    expect(t.status).toBe(200);
    expect(t.last!.data).toMatchObject({ quota: { limit: 2, remaining: 1 } });
  });
});
