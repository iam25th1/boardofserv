// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { clientAddress, LIMITS, rateLimited, resetRateLimits } from "./rateLimit";

// Every route anyone can reach without signing in is limited per address:
// a fixed window a minute, a 429 with Retry-After over it, each address
// and route group counted on its own.

afterEach(() => resetRateLimits());

const from = (ip: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/board", { headers: { "cf-connecting-ip": ip, ...headers } });

describe("the public rate limit", () => {
  it("lets an address make its calls a minute, then answers 429 with when to come back", async () => {
    const t = 1_000_000;
    for (let i = 0; i < LIMITS.read; i++) expect(rateLimited(from("203.0.113.7"), "read", t)).toBeNull();
    const over = rateLimited(from("203.0.113.7"), "read", t + 10_000)!;
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBe("50");
    expect(await over.json()).toEqual({ error: "Too many requests. Try again in a minute." });
    // Another address, or another group, isn't affected; a new minute starts afresh.
    expect(rateLimited(from("198.51.100.2"), "read", t + 10_000)).toBeNull();
    expect(rateLimited(from("203.0.113.7"), "health", t + 10_000)).toBeNull();
    expect(rateLimited(from("203.0.113.7"), "read", t + 60_001)).toBeNull();
  });

  it("takes the address from Cloudflare first, then the first forwarded one", () => {
    expect(clientAddress(from("203.0.113.7", { "x-forwarded-for": "10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientAddress(new Request("http://x/", { headers: { "x-forwarded-for": "198.51.100.9, 10.0.0.1" } }))).toBe("198.51.100.9");
    expect(clientAddress(new Request("http://x/"))).toBe("unknown");
  });

  it("is on every route that doesn't need sign-in", () => {
    const routes = execSync("find src/app -name route.ts", { encoding: "utf8" }).trim().split("\n");
    const open = routes.filter((f) => !/getUserFromRequest|requireAdmin|ownedAgent/.test(readFileSync(f, "utf8")));
    expect(open.length).toBeGreaterThan(5);
    // Routes that read a user without needing one are public too.
    for (const f of [...open, "src/app/api/requests/route.ts", "src/app/api/requests/[id]/route.ts", "src/app/api/market/agents/[id]/route.ts", "src/app/api/helpers/[slug]/route.ts"]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/rateLimited\(req, "(read|health|webhook|callback|page|demo)"\)/);
    }
  });
});

describe("a public route over its limit", () => {
  it("answers 429 before doing any work", async () => {
    const { GET } = await import("@/app/api/health/route");
    for (let i = 0; i < LIMITS.health; i++) rateLimited(from("192.0.2.44"), "health");
    const res = await GET(new Request("http://localhost/api/health", { headers: { "cf-connecting-ip": "192.0.2.44" } }));
    expect(res.status).toBe(429);
  });
});
