import { describe, expect, it } from "vitest";
import { privyAppId } from "./privy-config";

describe("privyAppId", () => {
  it("is null when the id is missing, empty or the CI placeholder", () => {
    expect(privyAppId(undefined)).toBeNull();
    expect(privyAppId("")).toBeNull();
    expect(privyAppId("ci-placeholder")).toBeNull();
  });

  it("is null for any id Privy itself would refuse (not 25 characters)", () => {
    expect(privyAppId("x".repeat(24))).toBeNull();
    expect(privyAppId("x".repeat(26))).toBeNull();
  });

  it("passes a Privy-shaped id through unchanged", () => {
    const id = "x".repeat(25);
    expect(privyAppId(id)).toBe(id);
  });
});
