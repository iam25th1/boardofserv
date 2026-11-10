// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { addr } from "@/test/fakeChain";
import { privyWalletOwner, verifyPrivyToken } from "@/lib/privy";
import { getUserFromRequest } from "@/lib/auth-route";
import { ownerOf, walletsOf } from "./wallets";
import { defaultOwnerLookup } from "./deposits";

// Linked wallets come from Privy only: the server asks Privy who the user is
// and which wallets they linked, and never takes an address from the browser.

const state = vi.hoisted(() => ({ db: null as unknown, linked: [] as unknown[], down: false }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@privy-io/node", () => {
  class NotFoundError extends Error {}
  const user = () => ({ id: "did:privy:maya", linked_accounts: state.linked });
  return {
    NotFoundError,
    PrivyClient: class {
      utils() {
        return {
          auth: () => ({
            async verifyAccessToken(token: string) {
              if (token !== "good-token") throw new Error("invalid token");
              return { user_id: "did:privy:maya" };
            },
          }),
        };
      }
      users() {
        return {
          _get: async () => user(),
          // Privy answers 404 when no user has the wallet.
          async getByWalletAddress({ address }: { address: string }) {
            if (state.down) throw new Error("503 Service Unavailable");
            const has = state.linked.some((a) => (a as { address?: string }).address?.toLowerCase() === address.toLowerCase());
            if (!has) throw new NotFoundError("User not found");
            return user();
          },
        };
      }
    },
  };
});

const EMBEDDED = addr(0xe1);
const METAMASK = addr(0xe2);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "a".repeat(25));
  vi.stubEnv("PRIVY_APP_SECRET", "test-secret");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});
beforeEach(async () => {
  await client.exec("delete from linked_wallets; delete from users;");
  state.down = false;
  state.linked = [
    { type: "email", address: "maya@example.com" },
    { type: "wallet", chain_type: "ethereum", address: EMBEDDED, wallet_client_type: "privy" },
    { type: "wallet", chain_type: "ethereum", address: METAMASK, wallet_client_type: "metamask" },
    { type: "wallet", chain_type: "solana", address: "So1anaAddre55" },
    { type: "smart_wallet", address: addr(0xe3) },
  ];
});

const req = (token = "good-token") => new Request("http://localhost/api/wallet", { headers: { authorization: `Bearer ${token}` } });

describe("linked wallets", () => {
  it("reads the embedded wallet and external Ethereum wallets from Privy", async () => {
    const id = await verifyPrivyToken("good-token");
    expect(id.wallets).toEqual([
      { address: EMBEDDED, embedded: true },
      { address: METAMASK, embedded: false },
    ]);
  });

  it("brings the stored copy in step with Privy only when asked to", async () => {
    const user = (await getUserFromRequest(req()))!;
    expect(await walletsOf(user.id)).toEqual([]);
    await getUserFromRequest(req(), { wallets: true });
    expect((await walletsOf(user.id)).map((w) => w.address).sort()).toEqual([EMBEDDED.toLowerCase(), METAMASK.toLowerCase()].sort());
    expect(await ownerOf(db as never, METAMASK)).toBe(user.id);

    // Unlinked in Privy: gone here too.
    state.linked = state.linked.filter((a) => (a as { address?: string }).address !== METAMASK);
    await getUserFromRequest(req(), { wallets: true });
    expect((await walletsOf(user.id)).map((w) => w.address)).toEqual([EMBEDDED.toLowerCase()]);
    expect(await ownerOf(db as never, METAMASK)).toBeNull();
  });

  it("moves a wallet to the user Privy now says has it", async () => {
    const sam = await addUser(db, "sam");
    await db.insert(schema.linkedWallets).values({ address: METAMASK.toLowerCase(), userId: sam.id });
    const maya = (await getUserFromRequest(req(), { wallets: true }))!;
    expect(await ownerOf(db as never, METAMASK)).toBe(maya.id);
  });

  it("reads the email they signed in with, or their Google account's", async () => {
    expect((await verifyPrivyToken("good-token")).email).toBe("maya@example.com");
    state.linked = [{ type: "google_oauth", email: "maya.g@example.com", subject: "g-1" }, ...state.linked.filter((a) => (a as { type: string }).type !== "email")];
    expect((await verifyPrivyToken("good-token")).email).toBe("maya.g@example.com");
    state.linked = state.linked.filter((a) => (a as { type: string }).type === "wallet");
    expect((await verifyPrivyToken("good-token")).email).toBeNull();
  });

  it("does nothing for a bad token", async () => {
    expect(await getUserFromRequest(req("bad-token"), { wallets: true })).toBeNull();
    expect(await db.select().from(schema.linkedWallets)).toHaveLength(0);
  });

  it("the deposit watcher asks Privy who owns a sender, and keeps the answer", async () => {
    const maya = await addUser(db, "maya");
    const lookup = defaultOwnerLookup();
    expect(await lookup(METAMASK)).toBe(maya.id);
    expect(await ownerOf(db as never, METAMASK)).toBe(maya.id);
    // A smart wallet or an unknown address belongs to no one.
    expect(await lookup(addr(0xe3))).toBeNull();
    expect(await lookup(addr(0xbad))).toBeNull();
  });

  it("says nobody owns a wallet only when Privy says so, never when Privy is down", async () => {
    expect(await privyWalletOwner(addr(0xbad))).toBeNull();
    state.down = true;
    await expect(privyWalletOwner(METAMASK)).rejects.toThrow("503");
  });
});
