// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

// End to end sign-in with a Privy server wallet, the method FINDINGS.md proved
// works (an embedded Google/email wallet is the same plain EOA but needs a
// browser to mint, so the server wallet stands in). This hits live Privy and
// OpenServ and spends nothing (SIWE is an offline signature). It runs only when
// RUN_E2E=1 and Privy credentials are present, so the normal gate stays
// offline and deterministic.
const enabled = process.env.RUN_E2E === "1" && Boolean(process.env.PRIVY_APP_SECRET) && Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const maybe = enabled ? it : it.skip;

const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const secret = process.env.PRIVY_APP_SECRET ?? "";

function privyHeaders(): Record<string, string> {
  const basic = Buffer.from(`${appId}:${secret}`).toString("base64");
  return { authorization: `Basic ${basic}`, "privy-app-id": appId, "content-type": "application/json", accept: "application/json" };
}

beforeAll(() => {
  if (!process.env.OPENSERV_KEY_ENC_KEY) process.env.OPENSERV_KEY_ENC_KEY = randomBytes(32).toString("base64");
});

describe("sign in to OpenServ with a Privy wallet", () => {
  maybe(
    "creates (or reuses) an account and we can store the key encrypted",
    async () => {
      const headers = privyHeaders();
      // Reuse a persisted server wallet when PRIVY_WALLET_ID is set, so the same
      // OpenServ account is used each run instead of creating a new one.
      let walletId = process.env.PRIVY_WALLET_ID ?? "";
      let address = "";
      if (walletId) {
        const r = await fetch(`https://api.privy.io/v1/wallets/${walletId}`, { headers });
        address = ((await r.json()) as { address?: string }).address ?? "";
      }
      if (!address) {
        const r = await fetch("https://api.privy.io/v1/wallets", {
          method: "POST",
          headers,
          body: JSON.stringify({ chain_type: "ethereum" }),
        });
        const b = (await r.json()) as { id?: string; address?: string };
        walletId = b.id ?? "";
        address = b.address ?? "";
      }
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);

      const { getSiweChallenge, verifySiwe } = await import("@/lib/openserv");
      const { message } = await getSiweChallenge(address);

      const signRes = await fetch(`https://api.privy.io/v1/wallets/${walletId}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "personal_sign", params: { message, encoding: "utf-8" } }),
      });
      const signature = ((await signRes.json()) as { data?: { signature?: string } }).data?.signature ?? "";
      expect(signature).toMatch(/^0x[0-9a-fA-F]+$/);

      const { apiKey, openservUserId } = await verifySiwe(address, message, signature);
      expect(apiKey).toMatch(/^[0-9a-f]{32}$/);
      expect(openservUserId).not.toBe("");

      const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
      const stored = encryptSecret(apiKey);
      expect(stored).not.toContain(apiKey);
      expect(decryptSecret(stored)).toBe(apiKey);
    },
    45_000,
  );
});