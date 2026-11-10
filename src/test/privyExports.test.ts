import { describe, expect, it } from "vitest";

// The Privy 3 package itself, not a mock: every hook and component the app
// uses is still there, under the same name (sign-in by email, the embedded
// wallet, linking an external wallet, signing with it).
describe("@privy-io/react-auth", () => {
  it("still exports what the app uses", async () => {
    const privy = await import("@privy-io/react-auth");
    for (const name of ["PrivyProvider", "usePrivy", "useLinkAccount", "useWallets", "useSignMessage"] as const) {
      expect(typeof privy[name], name).toBe("function");
    }
  }, 60_000);
});
