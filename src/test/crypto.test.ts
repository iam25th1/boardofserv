import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

beforeAll(() => {
  process.env.OPENSERV_KEY_ENC_KEY = randomBytes(32).toString("base64");
});

describe("secret encryption at rest", () => {
  it("round-trips an OpenServ key", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
    const key = "a".repeat(32);
    const stored = encryptSecret(key);
    expect(stored).not.toContain(key);
    expect(stored.split(".")).toHaveLength(3);
    expect(decryptSecret(stored)).toBe(key);
  });

  it("rejects tampered ciphertext", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
    const stored = encryptSecret("some-secret-value");
    const parts = stored.split(".");
    const flipped = Buffer.from(parts[2]!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    parts[2] = flipped.toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("fails when the key is the wrong length", async () => {
    process.env.OPENSERV_KEY_ENC_KEY = Buffer.from("short").toString("base64");
    const { encryptSecret } = await import("@/lib/crypto");
    expect(() => encryptSecret("x")).toThrow();
    process.env.OPENSERV_KEY_ENC_KEY = randomBytes(32).toString("base64");
  });
});
