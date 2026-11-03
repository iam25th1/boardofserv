// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { addr } from "@/test/fakeChain";
import { verifyPrivyToken } from "@/lib/privy";
import { getUserFromRequest } from "@/lib/auth-route";
import { ownerOf, walletsOf } from "./wallets";
import { defaultOwnerLookup } from "./deposits";

// Linked wallets come from Privy only: the server asks Privy who the user is
// and which wallets they linked, and never takes an address from the browser.

const state = vi.hoisted(() => ({ db: null as unknown, linked: [] as unknown[] }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@privy-io/server-auth", () => ({
  PrivyClient: class {
    async verifyAuthToken(token: string) {
      if (token !== "good-token") throw new Error("invalid token");
      return { userId: "did:privy:maya" };
    }
    async getUser() {
      return { email: { address: "maya@example.com" }, linkedAccounts: state.linked };
    }
    async getUserByWalletAddress(address: string) {
      const has = state.linked.some((a) => (a as { address?: string }).address?.toLowerCase() === address.toLowerCase());
      return has ? { id: "did:privy:maya", linkedAccounts: state.linked } : null;
    }
  },
}));

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
  state.linked = [
    { type: "email", address: "maya@example.com" },
    { type: "wallet", chainType: "ethereum", address: EMBEDDED, walletClientType: "privy" },
    { type: "wallet", chainType: "ethereum", address: METAMASK, walletClientType: "metamask" },
    { type: "wallet", chainType: "solana", address: "So1anaAddre55" },
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
});
