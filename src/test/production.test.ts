// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// What the production build serves: development-only routes are gone, the
// health check says only what it should, and every response carries the
// security headers. The unit checks run with every test run; the server
// checks run in `npm run test:build`, right after `next build`, against
// `next start` on that build.

const ROOT = join(__dirname, "..", "..");
// Written only in the ?sketch fixture (src/lib/agentSketch.fixture.ts).
const SKETCH_MARKER = "0.4 credit a day";

// The production policy as it was before Cloudflare's analytics hosts were
// allowed, so a test can show those are the only change.
const POLICY_BEFORE_ANALYTICS = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://walletconnect.com https://walletconnect.org https://secure.walletconnect.com https://secure.walletconnect.org https://explorer-api.walletconnect.com https://api.web3modal.com https://api.web3modal.org",
  "font-src 'self' https://fonts.reown.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://secure.walletconnect.com https://secure.walletconnect.org",
  "frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://secure.walletconnect.com https://secure.walletconnect.org https://challenges.cloudflare.com",
  "connect-src 'self' https://auth.privy.io https://*.rpc.privy.systems wss://www.walletlink.org https://explorer-api.walletconnect.com https://relay.walletconnect.com https://relay.walletconnect.org wss://relay.walletconnect.com wss://relay.walletconnect.org https://rpc.walletconnect.com https://rpc.walletconnect.org https://pulse.walletconnect.com https://pulse.walletconnect.org https://keys.walletconnect.com https://keys.walletconnect.org https://notify.walletconnect.com https://notify.walletconnect.org https://echo.walletconnect.com https://echo.walletconnect.org https://push.walletconnect.com https://push.walletconnect.org https://api.web3modal.com https://api.web3modal.org",
  "worker-src 'self'",
  "manifest-src 'self'",
];

const state = vi.hoisted(() => ({ up: true }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: async () => {
      if (!state.up) throw new Error("connect ECONNREFUSED 127.0.0.1:5433");
      return { rows: [{ "?column?": 1 }] };
    },
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  state.up = true;
});

describe("development-only routes in production", () => {
  // Importing the demo pulls in every chat component, which can take more than
  // the default five seconds on a busy machine.
  it("/demo is a 404 in production, whatever it is asked for", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: DemoPage } = await import("@/app/demo/page");
    for (const searchParams of [{}, { pay: "wallet" }, { pay: "admin" }, { sketch: "demo" }, { left: "paused" }, { agent: "restock" }]) {
      await expect(DemoPage({ searchParams: Promise.resolve(searchParams) })).rejects.toThrow(expect.objectContaining({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" }));
    }
  }, 30_000);
});

describe("the example agent", () => {
  it("runs on the demo's bench only in development: a 404 anywhere else", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { POST } = await import("@/app/api/demo/agent/route");
    const res = await POST(new Request("http://localhost/api/demo/agent", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });

  it("runs for real in the live demo only in development: a 404 anywhere else", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const live = await import("@/app/api/demo/agent/live/route");
    expect((await live.GET(new Request("http://localhost/api/demo/agent/live"))).status).toBe(404);
    expect((await live.GET(new Request("http://localhost/api/demo/agent/live?page=prices"))).status).toBe(404);
    expect((await live.POST(new Request("http://localhost/api/demo/agent/live", { method: "POST", body: '{"action":"run"}' }))).status).toBe(404);
  });
});

describe("GET /api/health", () => {
  it("is ok with the network and whether payments are on, and nothing else", async () => {
    const { resetPaymentsConfig } = await import("@/lib/payments/config");
    vi.stubEnv("TREASURY_ADDRESS", `0x${"7e".repeat(20)}`);
    vi.stubEnv("TREASURY_PRIVATE_KEY", `0x${"ab".repeat(32)}`);
    resetPaymentsConfig();
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, database: "up", network: "Base Sepolia", payments: "on" });
    expect(text.toLowerCase()).not.toContain("7e7e7e");
    expect(text.toLowerCase()).not.toContain("abab");
    resetPaymentsConfig();
  });

  it("is a 503 while the database can't be reached, without the error", async () => {
    const { resetPaymentsConfig } = await import("@/lib/payments/config");
    resetPaymentsConfig();
    state.up = false;
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(new Request("http://localhost/api/health"));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, database: "down", network: "Base Sepolia", payments: "off" });
    expect(text).not.toContain("ECONNREFUSED");
  });
});

describe("security headers", () => {
  it("the production build sends a policy that allows Privy and refuses framing", async () => {
    // @ts-expect-error next.config.mjs is plain JavaScript, without types
    const { SECURITY_HEADERS } = await import("../../next.config.mjs");
    const prod = Object.fromEntries(SECURITY_HEADERS(true).map((h: { key: string; value: string }) => [h.key, h.value]));
    expect(prod["X-Content-Type-Options"]).toBe("nosniff");
    expect(prod["X-Frame-Options"]).toBe("DENY");
    expect(prod["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    const csp = prod["Content-Security-Policy"];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    for (const privy of ["frame-src https://auth.privy.io", "connect-src 'self' https://auth.privy.io", "https://*.rpc.privy.systems", "wss://relay.walletconnect.com"]) {
      expect(csp).toContain(privy);
    }
    // WalletConnect's modal, which Privy opens to link a wallet, reaches
    // Reown's hosts: seen blocked on the live site before they were listed.
    const directive = (name: string) => csp.split("; ").find((d: string) => d.startsWith(`${name} `)) ?? "";
    expect(directive("connect-src")).toContain("https://api.web3modal.org");
    expect(directive("connect-src")).toContain("https://pulse.walletconnect.org");
    expect(directive("font-src")).toContain("https://fonts.reown.com");
    expect(directive("img-src")).toContain("https://api.web3modal.org");
    expect(directive("frame-src")).toContain("https://secure.walletconnect.org");
    // Nothing anywhere, and no analytics beacon but Cloudflare's.
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
    expect(csp).not.toContain("cca-lite.coinbase.com");
  });

  it("allows Cloudflare's Web Analytics beacon, and nothing else it blocked before", async () => {
    // @ts-expect-error next.config.mjs is plain JavaScript, without types
    const { SECURITY_HEADERS } = await import("../../next.config.mjs");
    const csp: string = SECURITY_HEADERS(true).find((h: { key: string }) => h.key === "Content-Security-Policy").value;
    const parse = (policy: string) =>
      new Map(
        policy.split("; ").map((d) => {
          const [name, ...sources] = d.split(" ");
          return [name, sources] as const;
        }),
      );
    const before = parse(POLICY_BEFORE_ANALYTICS.join("; "));
    const now = parse(csp);
    expect([...now.keys()]).toEqual([...before.keys()]);
    const added = new Map([...now].map(([name, sources]) => [name, sources.filter((s) => !before.get(name)!.includes(s))]));
    const dropped = [...before].flatMap(([name, sources]) => sources.filter((s) => !now.get(name)!.includes(s)));
    // Exactly the two hosts in Cloudflare's CSP table, each in its directive.
    expect(Object.fromEntries([...added].filter(([, s]) => s.length > 0))).toEqual({
      "script-src": ["https://static.cloudflareinsights.com"],
      "connect-src": ["https://cloudflareinsights.com"],
    });
    expect(dropped).toEqual([]);
    expect(csp).not.toMatch(/\*\.cloudflareinsights\.com|http:\/\/[a-z.]*cloudflareinsights/);
  });

  it("the development server only refuses framing, so fast refresh keeps working", async () => {
    // @ts-expect-error next.config.mjs is plain JavaScript, without types
    const { SECURITY_HEADERS } = await import("../../next.config.mjs");
    const dev = Object.fromEntries(SECURITY_HEADERS(false).map((h: { key: string; value: string }) => [h.key, h.value]));
    expect(dev["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(dev["X-Content-Type-Options"]).toBe("nosniff");
    // Plain http on localhost: no HSTS there.
    expect(dev["Strict-Transport-Security"]).toBeUndefined();
  });

  it("turns the image optimizer off (nothing uses next/image)", async () => {
    // @ts-expect-error next.config.mjs is plain JavaScript, without types
    const config = (await import("../../next.config.mjs")).default;
    expect(config.images).toEqual({ unoptimized: true });
  });

  it("production adds HSTS and a permissions policy that leaves sign-in and the copy buttons alone", async () => {
    // @ts-expect-error next.config.mjs is plain JavaScript, without types
    const { SECURITY_HEADERS } = await import("../../next.config.mjs");
    const prod = Object.fromEntries(SECURITY_HEADERS(true).map((h: { key: string; value: string }) => [h.key, h.value]));
    expect(prod["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains");
    const pp: string = prod["Permissions-Policy"];
    for (const off of ["camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()"]) expect(pp).toContain(off);
    // Nothing Privy's sign-in or the clipboard needs is turned off.
    expect(pp).not.toMatch(/clipboard|publickey-credentials|storage-access|identity-credentials/);
    for (const key of ["Content-Security-Policy", "X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy"]) expect(prod[key], key).toBeTruthy();
  });
});

// The production server itself, on the build `npm run test:build` just made.
describe.runIf(process.env.CHECK_BUILD === "1")("the production server", () => {
  let server: ChildProcess;
  let base = "";
  let output = "";

  beforeAll(async () => {
    expect(existsSync(join(ROOT, ".next", "BUILD_ID")), "run next build first").toBe(true);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(join(ROOT, "node_modules", ".bin", "next"), ["start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: ROOT,
      detached: true,
      // Set here, so a developer's .env.local can't fill them in: no
      // database, no treasury, no payments worker.
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:9/none",
        TREASURY_ADDRESS: "",
        TREASURY_PRIVATE_KEY: "",
        BOS_PAYMENTS_WORKER: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (d) => (output += d));
    server.stderr?.on("data", (d) => (output += d));
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await fetch(`${base}/api/health`);
        break;
      } catch {
        if (Date.now() > deadline || server.exitCode !== null) throw new Error(`next start did not come up:\n${output}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }, 90_000);

  afterAll(() => {
    if (server?.pid) process.kill(-server.pid, "SIGTERM");
  });

  it.each(["/demo", "/demo?pay=wallet", "/demo?pay=admin", "/demo?sketch=demo&state=convo"])("%s is a 404", async (path) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(404);
  });

  it("?sketch fixtures are not served and not in the build", async () => {
    for (const path of ["/?sketch=demo", "/app/chat?sketch=ready", "/app/board?sketch=live"]) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(await res.text()).not.toContain(SKETCH_MARKER);
    }
    const offenders: string[] = [];
    for (const dir of ["static", "server"]) {
      for (const d of readdirSync(join(ROOT, ".next", dir), { recursive: true, withFileTypes: true })) {
        if (!d.isFile() || !/\.(js|mjs|cjs|json|html|rsc|body)$/.test(d.name)) continue;
        const file = join(d.parentPath ?? (d as unknown as { path: string }).path, d.name);
        if (readFileSync(file, "utf8").includes(SKETCH_MARKER)) offenders.push(file);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("/api/health answers with the network and payments off, and a 503 with no database", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, database: "down", network: "Base Sepolia", payments: "off" });
  });

  it.each(["/", "/login", "/app/board", "/api/health"])("%s carries the security headers", async (path) => {
    const res = await fetch(`${base}${path}`, { redirect: "manual" });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("https://auth.privy.io");
    expect(csp).toContain("https://static.cloudflareinsights.com");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it.each(["/", "/about", "/terms", "/privacy", "/support"])("%s loads signed out, with its share card", async (path) => {
    const res = await fetch(`${base}${path}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('property="og:image" content="https://boardofserv.25th.dev/brand/share-card.png"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  it("serves the share card and the logo, and no image optimizer", async () => {
    expect((await fetch(`${base}/brand/share-card.png`)).headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${base}/brand/logo-120.png`)).status).toBe(200);
    expect((await fetch(`${base}/_next/image?url=%2Fbrand%2Flogo-120.png&w=64&q=75`)).status).toBe(404);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}
