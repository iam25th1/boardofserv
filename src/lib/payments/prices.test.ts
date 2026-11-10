// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PricesBody } from "./prices";

describe("prices in a request", () => {
  it("may name one currency and leave the others out", () => {
    const parsed = PricesBody.safeParse({ USDC: "2500000" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ USDC: "2500000" });
    expect(PricesBody.safeParse({ SERV: null }).data).toEqual({ SERV: null });
  });

  it("refuses a currency it doesn't know and an amount that isn't digits", () => {
    expect(PricesBody.safeParse({ DOGE: "1" }).success).toBe(false);
    expect(PricesBody.safeParse({ USDC: "1.5" }).success).toBe(false);
  });
});
