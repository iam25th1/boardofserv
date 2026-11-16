// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { entryOf } from "./catalog";
import { connectService, ConnectRefused } from "./connect";
import { callService, fetchTransport, forgetExchanged } from "./request";
import { connectionsOf } from "./vault";

// Where to get a key, as each service's own docs give it today, and the
// ways to connect that go with it: a Shopify app made in the Dev Dashboard
// (every new one since January 2026) connects with its client ID and
// secret, exchanged on the server for a token that lasts a day; an older
// app's Admin API token still works. HubSpot's keys are its service keys.

const CLIENT_SECRET = "shpss_test_client_secret_0001"; // gitleaks:allow (a made-up key the test plants)
const EXCHANGED = "shpat_test_exchanged_token_0001"; // gitleaks:allow (a made-up key the test plants)

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
});
beforeEach(() => forgetExchanged());
afterAll(async () => client.close());

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof ConnectRefused ? { status: e.status, message: e.message } : e));

describe("where to get a key", () => {
  it("is each service's current page", () => {
    expect(entryOf("hubspot")!.keyUrl).toBe("https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys");
    expect(entryOf("hubspot")!.keyHow).toMatch(/^In HubSpot, open Development, then Keys, Service keys/);
    expect(entryOf("gitlab")!.keyUrl).toBe("https://gitlab.com/-/user_settings/personal_access_tokens?name=boardofserv&scopes=read_api");
    // The address Discord's own developer docs link to for webhooks.
    expect(entryOf("discord")!.keyUrl).toBe("https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks");
    expect(entryOf("shopify")!.keyUrl).toBe("https://help.shopify.com/en/manual/apps/app-types/custom-apps");
    expect(entryOf("shopify")!.keyHow).toContain("Build apps in Dev Dashboard");
  });
});

describe("a Shopify app from the Dev Dashboard", () => {
  it("connects with its client ID and secret, exchanged on the server for a day's token that is never shown or kept", async () => {
    const owner = await addUser(db, "keys.shopify");
    const exchanges: Record<string, string>[] = [];
    rt.net.on(/acme-goods\.myshopify\.com\/admin\/oauth\/access_token/, (req) => {
      exchanges.push(Object.fromEntries(new URLSearchParams(req.body ?? "")));
      return Response.json({ access_token: EXCHANGED, scope: "read_orders,read_products", expires_in: 86399 });
    });
    rt.net.on(/acme-goods\.myshopify\.com\/admin\/api\/2026-01\/shop\.json/, (req) => (req.headers.get("x-shopify-access-token") === EXCHANGED ? Response.json({ shop: { name: "Acme Goods" } }) : Response.json({ errors: "Invalid API key or access token" }, { status: 401 })));
    const { label } = await connectService(rt, owner.id, "shopify", { shop: "acme-goods", client_id: "a1b2c3d4e5f6a7b8", client_secret: CLIENT_SECRET });
    expect(label).toBe("Shopify (Acme Goods)");
    expect(exchanges).toEqual([{ grant_type: "client_credentials", client_id: "a1b2c3d4e5f6a7b8", client_secret: CLIENT_SECRET }]);
    // The token is used again, not asked for again, while it lasts.
    const answer = await callService(entryOf("shopify")!, { shop: "acme-goods", client_id: "a1b2c3d4e5f6a7b8", client_secret: CLIENT_SECRET }, { method: "GET", path: "/shop.json" }, fetchTransport(rt.net.fetch));
    expect(answer.status).toBe(200);
    expect(exchanges).toHaveLength(1);
    const shown = JSON.stringify(await connectionsOf(rt, owner.id));
    for (const secret of [CLIENT_SECRET, EXCHANGED]) {
      expect(shown).not.toContain(secret);
      expect(rt.logged.join("\n")).not.toContain(secret);
    }
    const [row] = await db.select().from(schema.connections);
    expect(row!.secretEncrypted).not.toContain(CLIENT_SECRET);
  });

  it("says plainly when the client ID and secret are turned down, or only half given", async () => {
    const owner = await addUser(db, "keys.shopify.bad");
    rt.net.on(/bad-goods\.myshopify\.com\/admin\/oauth\/access_token/, () => Response.json({ error: "invalid_client" }, { status: 401 }));
    expect(await refusal(connectService(rt, owner.id, "shopify", { shop: "bad-goods", client_id: "a1b2c3d4e5f6a7b8", client_secret: "shpss_wrong_000000" }))).toEqual({
      status: 400,
      message: "Shopify turned down the app's client ID and secret (it answered 401): check them, and that the app is installed on the store. Check what you pasted.",
    });
    expect(await refusal(connectService(rt, owner.id, "shopify", { shop: "bad-goods", client_id: "a1b2c3d4e5f6a7b8" }))).toEqual({
      status: 400,
      message: "Paste your Shopify Client ID and Client secret, or your Admin API access token from an app made before 2026.",
    });
  });

  it("still takes an older app's Admin API access token, with no exchange", async () => {
    const owner = await addUser(db, "keys.shopify.legacy");
    rt.net.on(/old-goods\.myshopify\.com\/admin\/api\/2026-01\/shop\.json/, (req) => Response.json({ shop: { name: req.headers.get("x-shopify-access-token") === "shpat_legacy_token_0001" ? "Old Goods" : "?" } })); // gitleaks:allow (a made-up key the test plants)
    const before = rt.net.calls.filter((c) => c.url.pathname.endsWith("/access_token")).length;
    expect((await connectService(rt, owner.id, "shopify", { shop: "old-goods", token: "shpat_legacy_token_0001" })).label).toBe("Shopify (Old Goods)"); // gitleaks:allow (a made-up key the test plants)
    expect(rt.net.calls.filter((c) => c.url.pathname.endsWith("/access_token")).length).toBe(before);
  });
});

describe("a HubSpot service key", () => {
  it("connects even when its scopes don't reach the account's details", async () => {
    const owner = await addUser(db, "keys.hubspot");
    rt.net.on(/api\.hubapi\.com\/account-info\/v3\/details/, () => Response.json({ status: "error", category: "MISSING_SCOPES", message: "This app hasn't been granted all required scopes" }, { status: 403 }));
    expect((await connectService(rt, owner.id, "hubspot", { token: "made-up-hubspot-service-key" })).label).toBe("HubSpot (a key for some of your CRM)");
  });
});
