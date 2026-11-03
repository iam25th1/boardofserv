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
  it("/demo is a 404 in production, whatever it is asked for", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: DemoPage } = await import("@/app/demo/page");
    for (const searchParams of [{}, { pay: "wallet" }, { pay: "admin" }, { sketch: "demo" }]) {
      expect(() => DemoPage({ searchParams })).toThrow(expect.objectContaining({ digest: "NEXT_NOT_FOUND" }));
    }
  });
});

describe("GET /api/health", () => {
  it("is ok with the network and whether payments are on, and nothing else", async () => {
    const { resetPaymentsConfig } = await import("@/lib/payments/config");
    vi.stubEnv("TREASURY_ADDRESS", `0x${"7e".repeat(20)}`);
    vi.stubEnv("TREASURY_PRIVATE_KEY", `0x${"ab".repeat(32)}`);
    resetPaymentsConfig();
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
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
    const res = await GET();
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
    // Nothing anywhere, and no analytics beacons.
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
    expect(csp).not.toContain("cloudflareinsights");
    expect(csp).not.toContain("cca-lite.coinbase.com");
  });

  it("the development server only refuses framing, so fast refresh keeps working", async () => {
    // @ts-expect-error next.config.mjs is plain JavaScript, without types
    const { SECURITY_HEADERS } = await import("../../next.config.mjs");
    const dev = Object.fromEntries(SECURITY_HEADERS(false).map((h: { key: string; value: string }) => [h.key, h.value]));
    expect(dev["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(dev["X-Content-Type-Options"]).toBe("nosniff");
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
    for (const path of ["/?sketch=demo", "/chat?sketch=ready", "/board?sketch=live"]) {
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

  it.each(["/", "/login", "/board", "/api/health"])("%s carries the security headers", async (path) => {
    const res = await fetch(`${base}${path}`, { redirect: "manual" });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("https://auth.privy.io");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-powered-by")).toBeNull();
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
