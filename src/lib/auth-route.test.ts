// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// Sign-in from the privy-token cookie: a browser sends it on requests other
// sites start too, so a change a browser marks as cross-site or same-site
// (a sibling subdomain) gets no user from it. The bearer header, which only
// the app's own pages send, and reads are unaffected.

const USER = { id: "u1", privyUserId: "did:privy:u1", email: "maker@example.com" };
vi.mock("./privy", () => ({ verifyPrivyToken: async () => ({ userId: "did:privy:u1", email: "maker@example.com", wallets: [] }) }));
vi.mock("./db/index", () => ({ db: { query: { users: { findFirst: async () => USER } } } }));
vi.mock("./users", () => ({ createUser: async () => USER }));
vi.mock("./payments/wallets", () => ({ syncWallets: async () => undefined }));

const { getUserFromRequest } = await import("./auth-route");

const req = (method: string, headers: Record<string, string>) => new Request("https://boardofserv.example/api/agents", { method, headers });
const COOKIE = { cookie: "other=1; privy-token=a.b.c" };

describe("getUserFromRequest", () => {
  it("signs in a change from the cookie only when the browser says it came from this site", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(await getUserFromRequest(req(method, { ...COOKIE, "sec-fetch-site": "cross-site" })), method).toBeNull();
      expect(await getUserFromRequest(req(method, { ...COOKIE, "sec-fetch-site": "same-site" })), method).toBeNull();
      expect(await getUserFromRequest(req(method, { ...COOKIE, "sec-fetch-site": "same-origin" })), method).toEqual(USER);
      // Not from a browser that marks requests (scripts, older browsers).
      expect(await getUserFromRequest(req(method, COOKIE)), method).toEqual(USER);
    }
  });

  it("always takes the bearer header, and the cookie on reads", async () => {
    expect(await getUserFromRequest(req("POST", { authorization: "Bearer a.b.c", "sec-fetch-site": "cross-site" }))).toEqual(USER);
    expect(await getUserFromRequest(req("GET", { ...COOKIE, "sec-fetch-site": "cross-site" }))).toEqual(USER);
    expect(await getUserFromRequest(req("POST", {}))).toBeNull();
  });
});
