// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ServiceEntry } from "./catalog";
import { buildRequest, callService, guardedTransport, redact, secretValues, ServiceRefused, ServiceUnreachable, type Transport } from "./request";
import { checkCode } from "../agents/code";
import type { CodeStepDef } from "../agents/definition";

// A call through a connection: the server adds the secret, reaches only
// the service's own hosts, never a private address, and nothing it hands
// back (data, errors) carries the secret.

const KEY = "ghp_live_secret_key_0123456789"; // gitleaks:allow (a made-up key the test plants)

const keyed: ServiceEntry = {
  id: "keyed",
  name: "Keyed",
  category: "work",
  auth: "bearer",
  aliases: [],
  fields: [{ key: "key", label: "Key", secret: true }],
  base: "https://api.keyed.test/v1",
  hosts: ["api.keyed.test"],
  place: { in: "header", name: "authorization", prefix: "Bearer " },
  check: { method: "GET", path: "/me", label: "login" },
  keyUrl: "https://keyed.test/keys",
  keyHow: "Make a key.",
  reads: "Things.",
  writes: "Things.",
  tools: [],
};

const shop: ServiceEntry = { ...keyed, id: "shop", base: "https://{shop}.shop.test/api", hosts: ["{shop}.shop.test"], fields: [{ key: "shop", label: "Shop", secret: false }, { key: "key", label: "Key", secret: true }], place: { in: "header", name: "x-shop-token" } };
const queried: ServiceEntry = { ...keyed, id: "queried", place: { in: "query", name: "apikey" } };
const basic: ServiceEntry = { ...keyed, id: "basic", fields: [{ key: "account", label: "Account", secret: false }, { key: "key", label: "Token", secret: true }], place: { in: "basic", user: "account" } };
const hook: ServiceEntry = { ...keyed, id: "hook", auth: "webhook_url", base: "https://hooks.test", hosts: ["hooks.test"], fields: [{ key: "url", label: "Webhook", secret: true }], place: { in: "url" } };

// A transport that answers from a table of addresses, keeping each call.
function answering(table: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string | null }[] = [];
  const t: Transport = async (url, init) => {
    calls.push({ url, ...init });
    const a = table[url] ?? { status: 404, body: { message: "Not Found" } };
    return { status: a.status ?? 200, headers: { "content-type": "application/json", ...(a.headers ?? {}) }, body: Buffer.from(JSON.stringify(a.body ?? {})), cut: false };
  };
  return { t, calls };
}

describe("a call through a connection", () => {
  it("puts the secret where the service wants it, and only there", () => {
    const h = buildRequest(keyed, { key: KEY }, { method: "GET", path: "/repos/a/b", query: { per_page: 5 } });
    expect(h.url.toString()).toBe("https://api.keyed.test/v1/repos/a/b?per_page=5");
    expect(h.headers.authorization).toBe(`Bearer ${KEY}`);
    const q = buildRequest(queried, { key: KEY }, { method: "GET", path: "/x" });
    expect(q.url.searchParams.get("apikey")).toBe(KEY);
    expect(q.headers.authorization).toBeUndefined();
    const b = buildRequest(basic, { account: "AC123", key: KEY }, { method: "GET", path: "/x" });
    expect(Buffer.from(b.headers.authorization!.replace("Basic ", ""), "base64").toString()).toBe(`AC123:${KEY}`);
    const w = buildRequest(hook, { url: `https://hooks.test/api/webhooks/1/${KEY}` }, { method: "POST", path: "", body: { content: "Hi" } });
    expect(w.url.toString()).toBe(`https://hooks.test/api/webhooks/1/${KEY}`);
    expect(w.body).toBe('{"content":"Hi"}');
  });

  it("never leaves the service's own hosts", () => {
    const refused = (call: Parameters<typeof buildRequest>[2], entry = keyed, fields: Record<string, string> = { key: KEY }) => expect(() => buildRequest(entry, fields, call)).toThrow(ServiceRefused);
    refused({ method: "GET", path: "https://evil.test/steal" });
    refused({ method: "GET", path: "//evil.test/x" });
    refused({ method: "GET", path: "/../../etc" });
    refused({ method: "GET", path: "", url: "https://evil.test/" });
    // A field can't move the call to another host.
    refused({ method: "GET", path: "/x" }, shop, { shop: "evil.test/x?", key: KEY });
    refused({ method: "GET", path: "/x" }, shop, { shop: "a@evil.test", key: KEY });
    expect(buildRequest(shop, { shop: "acme", key: KEY }, { method: "GET", path: "/orders" }).url.host).toBe("acme.shop.test");
    // A webhook reaches its own host only.
    refused({ method: "POST", path: "", body: {} }, hook, { url: "http://hooks.test/x" });
  });

  it("follows a redirect only within the service, and says so plainly otherwise", async () => {
    const { t } = answering({
      "https://api.keyed.test/v1/moved": { status: 301, headers: { location: "https://api.keyed.test/v1/here" } },
      "https://api.keyed.test/v1/here": { body: { ok: true } },
      "https://api.keyed.test/v1/away": { status: 302, headers: { location: "https://evil.test/collect" } },
    });
    expect(await callService(keyed, { key: KEY }, { method: "GET", path: "/moved" }, t)).toEqual({ status: 200, data: { ok: true } });
    await expect(callService(keyed, { key: KEY }, { method: "GET", path: "/away" }, t)).rejects.toThrow(/evil\.test, which this connection doesn't reach/);
  });

  it("hands back nothing that carries the secret", async () => {
    const { t } = answering({ "https://api.keyed.test/v1/echo": { body: { you_sent: `Bearer ${KEY}`, ok: true } } });
    const got = await callService(keyed, { key: KEY }, { method: "GET", path: "/echo" }, t);
    expect(JSON.stringify(got)).not.toContain(KEY);
    expect(got.data).toEqual({ you_sent: "Bearer [secret]", ok: true });
    const failing: Transport = async () => {
      throw new Error(`socket hang up for ${KEY}`);
    };
    const err = await callService(keyed, { key: KEY }, { method: "GET", path: "/x" }, failing).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ServiceUnreachable);
    expect(String((err as Error).message)).not.toContain(KEY);
    // A webhook's address is its secret: its token part is hidden too.
    expect(secretValues(hook, { url: `https://hooks.test/api/webhooks/1/${KEY}` })).toContain(KEY);
    expect(redact(`posted to https://hooks.test/api/webhooks/1/${KEY}`, [KEY])).not.toContain(KEY);
  });

  it("never reaches a private, local or reserved address, however the name resolves", async () => {
    const lookup = async () => [{ address: "10.0.0.7", family: 4 }];
    const t = guardedTransport({ lookup });
    await expect(callService(keyed, { key: KEY }, { method: "GET", path: "/x" }, t)).rejects.toThrow(/private, local or reserved/);
    const meta: ServiceEntry = { ...keyed, base: "https://169.254.169.254", hosts: ["169.254.169.254"] };
    await expect(callService(meta, { key: KEY }, { method: "GET", path: "/latest" }, guardedTransport())).rejects.toThrow(/private, local or reserved/);
  });
});

describe("code that handles a key itself", () => {
  const step = { id: "s", kind: "code", title: "Read", description: "Read.", inputs: ["settings"], outputs: ["rows"], tools: ["web.fetch"], next: null } as CodeStepDef;
  it("fails its check: keys are added by the server", () => {
    expect(checkCode(`async function run(input, tools) { const r = await tools.web.fetch({ url: input.settings.url, headers: { Authorization: "x" } }); return { rows: [] }; }`, step)).toMatch(/handles a key itself/);
    expect(checkCode('async function run(input, tools) { const h = "Bearer " + input.settings.key; return { rows: [h] }; }', step)).toMatch(/handles a key itself/);
    expect(checkCode("async function run(input, tools) { return { rows: [input.settings.api_key] }; }", step)).toBeNull();
    expect(checkCode('async function run(input, tools) { return { rows: ["Token price went up", "Basic plan"] }; }', step)).toBeNull();
  });
});
