// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { testDb } from "@/test/helperDb";
import { fakeNet, TEST_BOT_TOKEN } from "@/test/fakeNet";
import { testRuntime } from "@/test/runtimeFixtures";
import { storeWebhookSecret } from "./link";

// The webhook route reads an update only when it carries the secret set
// with the webhook, in Telegram's header; anything else is refused before
// its body is looked at.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
const net = fakeNet();

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", TEST_BOT_TOKEN);
  vi.stubEnv("TELEGRAM_DEV_WEBHOOK_SECRET", "");
  vi.stubGlobal("fetch", net.fetch);
  await storeWebhookSecret(testRuntime(db), "the-webhook-secret");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await client.close();
});

const post = async (secret: string | null, body: unknown) => {
  const { POST } = await import("@/app/api/telegram/webhook/route");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  return POST(new Request("http://localhost/api/telegram/webhook", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
};

const start = (id: number) => ({ update_id: id, message: { message_id: 1, from: { id: 5, first_name: "A" }, chat: { id: 5, type: "private" }, text: "/start" } });

describe("the webhook", () => {
  it("refuses a request without the secret, or with a wrong one", async () => {
    expect((await post(null, start(1))).status).toBe(401);
    expect((await post("not-the-secret", start(2))).status).toBe(401);
    expect((await post("", start(3))).status).toBe(401);
    expect(net.calls).toHaveLength(0);
  });

  it("reads an update with the secret", async () => {
    const res = await post("the-webhook-secret", start(4));
    expect(res.status).toBe(200);
    expect(net.telegram("sendMessage").at(-1)).toMatchObject({ chat_id: 5 });
  });

  it("refuses what isn't JSON, and ignores what isn't an update", async () => {
    expect((await post("the-webhook-secret", "{nope")).status).toBe(400);
    expect((await post("the-webhook-secret", { hello: 1 })).status).toBe(200);
  });

  it("takes the development secret only outside production", async () => {
    vi.stubEnv("TELEGRAM_DEV_WEBHOOK_SECRET", "dev-secret");
    expect((await post("dev-secret", start(5))).status).toBe(200);
    vi.stubEnv("NODE_ENV", "production");
    expect((await post("dev-secret", start(6))).status).toBe(401);
    vi.stubEnv("NODE_ENV", "test");
  });
});
