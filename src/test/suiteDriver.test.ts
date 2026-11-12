// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { testDb } from "./helperDb";
import { planAnswer } from "./planAnswers";
import { PAY_SOURCES, PAY_WIRE, PRICE_SOURCES, PRICE_WIRE } from "./suiteFixtures";
import { Ledger } from "./suite/live";
import { SUITE } from "./suite/requests";
import { runJourney } from "./suite/journey";
import { suiteMaker } from "./suite/setup";

// The suite's driver, on stand-in models: it takes a request through all
// six stages the way a maker would, with the first message only, the
// steps, the build, the test, Connect (sheets, Telegram, who it pays) and
// Run it for me, typing nothing to fix it.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));
vi.mock("@/lib/google/sheets", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/google/sheets")>()), sheetInfo: (await import("./suite/setup")).sheetInfo }));

const PLANS: Record<string, { wire: Record<string, unknown>; sources: Record<string, string>; sample: Record<string, unknown> }> = {
  price: {
    wire: PRICE_WIRE,
    sources: PRICE_SOURCES,
    sample: { noun: "product", plural: "products", labels: ["Stone Kettle"], settings: [{ key: "product_url", value: "https://shop.example/kettle" }, { key: "target_price", value: "50" }], sheets: [], pages: [{ url: "https://shop.example/kettle", text: "Stone Kettle. Now $42.00." }], searches: [], answers: ["Yes"], steps: [] },
  },
  designer: {
    wire: PAY_WIRE,
    sources: PAY_SOURCES,
    sample: { noun: "payment", plural: "payments", labels: ["Weekly design fee"], settings: [{ key: "payee_name", value: "Designer" }, { key: "amount_usdc", value: "0.5" }], sheets: [], pages: [], searches: [], answers: [], steps: [] },
  },
};

let agent = "";
const stream = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
const answer = (content: unknown) => Response.json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
const models = (async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const p = PLANS[agent]!;
  if (url.includes("dphn.ai")) {
    const title = /^Step: (.+)$/m.exec(body.messages[1].content)?.[1];
    const id = (p.wire.steps as { id: string; title: string }[]).find((s) => s.title === title)?.id ?? "";
    return answer("```js\n" + p.sources[id] + "\n```");
  }
  if (body.stream) return stream("Your job is clear. I have what I need.");
  const name = body.response_format?.json_schema?.name as string;
  if (name === "agent_sketch") return answer({ name: p.wire.name, kind: "agent", watches: "", when: "", how: "", tells: "", takes: "", does: "", gives: "", wakes: "on its schedule", looks: "what it needs", handles: "does its job", finish: "", asks: "", setup: "", remembers: "", asking: "none", choices: [], change: "" });
  if (name === "agent_sample") return answer(p.sample);
  if (name === "code_review") return answer({ verdict: "approve", reason: "Does what the step says." });
  if (name === "version_review") return answer({ findings: [] });
  const planned = planAnswer(p.wire, body);
  return planned ? answer(planned) : answer({});
}) as unknown as typeof fetch;

const ledger = new Ledger({ serv: 500, dolphin: 500 }, models);
let client: PGlite;
let db: PgliteDatabase<typeof schema>;
beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubEnv("SERV_API_KEY", "test-serv");
  vi.stubEnv("DOLPHIN_API_KEY", "test-dolphin");
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", ledger.fetch);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await client.close();
});

describe("the suite's driver", () => {
  it.each(["price", "designer"])("takes %s through all six stages with nothing but the first message", { timeout: 60_000 }, async (id) => {
    agent = id;
    ledger.agent = id;
    const r = SUITE.find((x) => x.id === id)!;
    state.user = await suiteMaker(db, id);
    const result = await runJourney(r, { db, user: state.user as schema.User, ledger });
    expect(result.failure).toBeNull();
    expect(result).toMatchObject({ stage: 6, passed: true, typedFixes: 0, rounds: 0, questions: [] });
    expect(result.turns.map((t) => t.said)).toEqual([r.says]);
    if (id === "designer") {
      // Connect saved the payee by the name it pays, at the owner's wallet.
      const [p] = await db.select().from(schema.payees);
      expect(p).toMatchObject({ label: "Designer", status: "active" });
      expect(p!.address.toLowerCase()).toBe("0x0000000000000000000000000000000000000000");
    }
  });
});
