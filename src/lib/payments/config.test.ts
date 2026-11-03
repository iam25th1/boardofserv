import { describe, expect, it } from "vitest";
import { addr } from "@/test/fakeChain";
import { bootLines, enabledCurrencies, readPaymentsConfig } from "./config";

// Payments configuration from env. Nothing here touches a chain.

const TREASURY = addr(0x7ea5);

describe("payments config", () => {
  it("is off without a treasury, and says so at boot", () => {
    const c = readPaymentsConfig({});
    expect(c.enabled).toBe(false);
    expect(enabledCurrencies(c)).toEqual([]);
    expect(bootLines(c)).toEqual([{ level: "info", text: "payments: off (TREASURY_ADDRESS is not set)." }]);
  });

  it("defaults to Base Sepolia with USDC from Circle's list, 6 decimals, on", () => {
    const c = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY });
    expect(c).toMatchObject({ enabled: true, network: "base-sepolia", chainId: 84532, mainnet: false, confirmations: 5 });
    expect(c.currencies.USDC).toMatchObject({ enabled: true, chainId: 84532, decimals: 6, token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" });
    expect(c.currencies.USDC.withdrawMin).toBe(5_000_000n);
    expect(c.warnings).toEqual([]);
    expect(bootLines(c)).toEqual([{ level: "info", text: "payments: on, Base Sepolia (chain 84532), USDC." }]);
  });

  it("keeps SERV off until SERV_TOKEN_ADDRESS and SERV_TOKEN_DECIMALS are both set", () => {
    expect(readPaymentsConfig({ TREASURY_ADDRESS: TREASURY }).currencies.SERV.enabled).toBe(false);
    const noDecimals = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, SERV_TOKEN_ADDRESS: addr(0x5e7) });
    expect(noDecimals.currencies.SERV.enabled).toBe(false);
    expect(noDecimals.problems).toContain("SERV_TOKEN_DECIMALS must be set with SERV_TOKEN_ADDRESS. SERV is off.");
    const bad = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, SERV_TOKEN_ADDRESS: "0x123", SERV_TOKEN_DECIMALS: "18" });
    expect(bad.currencies.SERV.enabled).toBe(false);
    const on = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, SERV_TOKEN_ADDRESS: addr(0x5e7), SERV_TOKEN_DECIMALS: "18" });
    expect(on.currencies.SERV).toMatchObject({ enabled: true, decimals: 18, withdrawMin: null });
    expect(on.warnings).toContain("WITHDRAW_MIN_SERV is not set: SERV withdrawals are closed.");
    const off = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, SERV_TOKEN_ADDRESS: addr(0x5e7), SERV_TOKEN_DECIMALS: "18", SERV_ENABLED: "0" });
    expect(off.currencies.SERV.enabled).toBe(false);
  });

  it("keeps Base mainnet off without BOS_MAINNET=1", () => {
    const c = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, BOS_NETWORK: "base" });
    expect(c.enabled).toBe(false);
    expect(c.currencies.USDC.enabled).toBe(false);
    expect(c.problems).toContain("BOS_NETWORK=base needs BOS_MAINNET=1. Payments are off.");
    expect(readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, BOS_NETWORK: "base", BOS_MAINNET: "true" }).enabled).toBe(false);
  });

  it("turns Base mainnet on with BOS_MAINNET=1, with a warning at every boot", () => {
    const c = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, BOS_NETWORK: "base", BOS_MAINNET: "1" });
    expect(c).toMatchObject({ enabled: true, network: "base", chainId: 8453, mainnet: true });
    expect(c.currencies.USDC.token).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(bootLines(c)[0]).toEqual({ level: "warn", text: "payments: Payments are on Base mainnet (BOS_MAINNET=1): deposits and payouts move real funds." });
  });

  it("refuses an unknown network instead of guessing", () => {
    const c = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, BOS_NETWORK: "ethereum" });
    expect(c.enabled).toBe(false);
    expect(c.problems[0]).toMatch(/BOS_NETWORK must be base-sepolia or base/);
  });

  it("reads withdrawal limits as exact amounts, and keeps automatic payouts off without a daily cap", () => {
    const c = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, WITHDRAW_MIN_USDC: "2.5", WITHDRAW_AUTO_MAX_USDC: "20", WITHDRAW_DAILY_CAP_USDC: "100.000001" });
    expect(c.currencies.USDC).toMatchObject({ withdrawMin: 2_500_000n, autoMax: 20_000_000n, dailyCap: 100_000_001n });
    const noCap = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, WITHDRAW_AUTO_MAX_USDC: "20" });
    expect(noCap.currencies.USDC.autoMax).toBe(0n);
    expect(noCap.problems).toContain("WITHDRAW_AUTO_MAX_USDC needs WITHDRAW_DAILY_CAP_USDC. Every USDC withdrawal waits for approval.");
    const bad = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, WITHDRAW_MIN_USDC: "1e3" });
    expect(bad.problems).toContain("WITHDRAW_MIN_USDC is not an amount.");
    expect(bad.currencies.USDC.withdrawMin).toBeNull();
  });

  it("never puts the treasury key in the config or the boot log", () => {
    const key = `0x${"5a".repeat(32)}`;
    const c = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, TREASURY_PRIVATE_KEY: key });
    const text = JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + JSON.stringify(bootLines(c));
    expect(text).not.toContain("5a5a5a5a");
  });
});
