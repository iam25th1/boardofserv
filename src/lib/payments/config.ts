import { getAddress, isAddress, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { CURRENCIES, parseAmount, type Currency } from "../money";

// Payments configuration, read from the environment once per process.
//
// The network is Base Sepolia unless BOS_NETWORK=base, and Base (mainnet)
// also needs BOS_MAINNET=1: without it payments stay off. Each currency has a
// chain id, token address, decimals and an enabled flag. USDC defaults to
// Circle's address for the network; SERV stays off until the owner sets
// SERV_TOKEN_ADDRESS and SERV_TOKEN_DECIMALS (OpenServ's docs list a Base
// address but no decimals and no testnet token). The treasury address is
// public; its private key is never read here, only by the payout signer.

type Env = Record<string, string | undefined>;

export type NetworkName = "base-sepolia" | "base";

const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, label: "Base Sepolia", mainnet: false },
  base: { chain: base, label: "Base", mainnet: true },
} as const;

// USDC as Circle lists it: https://developers.circle.com/stablecoins/usdc-contract-addresses
const USDC_ADDRESS: Record<NetworkName, Address> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
const USDC_DECIMALS = 6;
const DEFAULT_WITHDRAW_MIN_USDC = "5";

export interface CurrencyConfig {
  code: Currency;
  chainId: number;
  token: Address | null;
  decimals: number;
  enabled: boolean;
  // Smallest withdrawal, or null while withdrawals of it are closed.
  withdrawMin: bigint | null;
  // A withdrawal below this is paid without approval, while the day's
  // automatic total stays within the daily cap. 0 means none are automatic.
  autoMax: bigint;
  dailyCap: bigint;
}

export interface PaymentsConfig {
  network: NetworkName;
  networkLabel: string;
  chainId: number;
  mainnet: boolean;
  rpcUrl: string | null;
  treasury: Address | null;
  currencies: Record<Currency, CurrencyConfig>;
  // A deposit counts once its block has this many confirmations (its own
  // block is the first).
  confirmations: number;
  scanIntervalMs: number;
  scanChunk: bigint;
  startBlock: bigint | null;
  adminUserIds: string[];
  // Payments run: the network is allowed, the treasury is set and at least
  // one currency is on.
  enabled: boolean;
  // What turned something off, and anything the owner should notice at boot.
  problems: string[];
  warnings: string[];
}

function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function wholeNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function address(raw: string | undefined): Address | null {
  const v = raw?.trim();
  return v && isAddress(v, { strict: false }) ? getAddress(v) : null;
}

export function readPaymentsConfig(env: Env = process.env): PaymentsConfig {
  const problems: string[] = [];
  const warnings: string[] = [];

  const rawNetwork = (env.BOS_NETWORK ?? "").trim() || "base-sepolia";
  const known = rawNetwork === "base" || rawNetwork === "base-sepolia";
  const network: NetworkName = rawNetwork === "base" ? "base" : "base-sepolia";
  const net = NETWORKS[network];
  let networkOk = known;
  if (!known) problems.push(`BOS_NETWORK must be base-sepolia or base, not "${rawNetwork}". Payments are off.`);
  if (known && net.mainnet) {
    if (env.BOS_MAINNET?.trim() === "1") warnings.push("Payments are on Base mainnet (BOS_MAINNET=1): deposits and payouts move real funds.");
    else {
      networkOk = false;
      problems.push("BOS_NETWORK=base needs BOS_MAINNET=1. Payments are off.");
    }
  }

  const treasury = address(env.TREASURY_ADDRESS);
  if (env.TREASURY_ADDRESS?.trim() && !treasury) problems.push("TREASURY_ADDRESS is not an address. Payments are off.");

  const amount = (name: string, decimals: number, fallback: string | null): bigint | null => {
    const raw = env[name]?.trim() || fallback;
    if (raw === null) return null;
    const v = parseAmount(raw, decimals);
    if (v === null) problems.push(`${name} is not an amount.`);
    return v;
  };

  const currency = (code: Currency): CurrencyConfig => {
    const isUsdc = code === "USDC";
    const tokenRaw = env[isUsdc ? "USDC_TOKEN_ADDRESS" : "SERV_TOKEN_ADDRESS"];
    let token = tokenRaw?.trim() ? address(tokenRaw) : isUsdc ? USDC_ADDRESS[network] : null;
    if (tokenRaw?.trim() && !token) problems.push(`${isUsdc ? "USDC_TOKEN_ADDRESS" : "SERV_TOKEN_ADDRESS"} is not an address. ${code} is off.`);

    const decimalsRaw = env[isUsdc ? "USDC_DECIMALS" : "SERV_TOKEN_DECIMALS"]?.trim();
    let decimals = isUsdc ? USDC_DECIMALS : -1;
    if (decimalsRaw) {
      const d = Number(decimalsRaw);
      if (Number.isInteger(d) && d >= 0 && d <= 36) decimals = d;
      else problems.push(`${isUsdc ? "USDC_DECIMALS" : "SERV_TOKEN_DECIMALS"} must be a whole number from 0 to 36. ${code} is off.`);
    }
    if (!isUsdc && token && decimals < 0) {
      problems.push("SERV_TOKEN_DECIMALS must be set with SERV_TOKEN_ADDRESS. SERV is off.");
      token = null;
    }

    const enabled = networkOk && !!treasury && !!token && decimals >= 0 && flag(env[`${code}_ENABLED`], true);
    const d = Math.max(decimals, 0);
    const withdrawMin = amount(`WITHDRAW_MIN_${code}`, d, isUsdc ? DEFAULT_WITHDRAW_MIN_USDC : null);
    let autoMax = amount(`WITHDRAW_AUTO_MAX_${code}`, d, "0") ?? 0n;
    const dailyCap = amount(`WITHDRAW_DAILY_CAP_${code}`, d, "0") ?? 0n;
    if (autoMax > 0n && dailyCap === 0n) {
      problems.push(`WITHDRAW_AUTO_MAX_${code} needs WITHDRAW_DAILY_CAP_${code}. Every ${code} withdrawal waits for approval.`);
      autoMax = 0n;
    }
    if (enabled && withdrawMin === null && !isUsdc) warnings.push("WITHDRAW_MIN_SERV is not set: SERV withdrawals are closed.");
    return { code, chainId: net.chain.id, token, decimals: d, enabled, withdrawMin, autoMax, dailyCap };
  };

  const currencies = Object.fromEntries(CURRENCIES.map((c) => [c, currency(c)])) as Record<Currency, CurrencyConfig>;

  const startRaw = env.DEPOSIT_START_BLOCK?.trim();
  const startBlock = startRaw && /^\d{1,20}$/.test(startRaw) ? BigInt(startRaw) : null;

  const enabled = networkOk && !!treasury && CURRENCIES.some((c) => currencies[c].enabled);

  return {
    network,
    networkLabel: net.label,
    chainId: net.chain.id,
    mainnet: net.mainnet,
    rpcUrl: env.BOS_RPC_URL?.trim() || null,
    treasury,
    currencies,
    confirmations: wholeNumber(env.DEPOSIT_CONFIRMATIONS, 5, 1, 1000),
    scanIntervalMs: wholeNumber(env.DEPOSIT_SCAN_INTERVAL_MS, 30_000, 5_000, 3_600_000),
    scanChunk: BigInt(wholeNumber(env.DEPOSIT_SCAN_CHUNK, 2_000, 10, 100_000)),
    startBlock,
    adminUserIds: (env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    enabled,
    problems,
    warnings,
  };
}

// What the database's binding (see binding.ts) turned off: payments
// altogether when the database holds another network's balances, or the
// currencies whose token changed.
export interface PaymentsLock {
  off: boolean;
  currencies: Currency[];
  problems: string[];
}

export function applyLock(config: PaymentsConfig, lock: PaymentsLock | null): PaymentsConfig {
  if (!lock || (!lock.off && lock.currencies.length === 0)) return config;
  const currencies = Object.fromEntries(
    CURRENCIES.map((c) => [c, lock.off || lock.currencies.includes(c) ? { ...config.currencies[c], enabled: false } : config.currencies[c]]),
  ) as Record<Currency, CurrencyConfig>;
  return {
    ...config,
    currencies,
    enabled: !lock.off && config.enabled && CURRENCIES.some((c) => currencies[c].enabled),
    problems: [...config.problems, ...lock.problems],
  };
}

// The boot sets the lock for the whole process (route handlers are bundled
// apart from the boot code, so it lives on globalThis, like the database
// pool).
const g = globalThis as unknown as { __bosPaymentsLock?: PaymentsLock | null };

export function setPaymentsLock(lock: PaymentsLock | null): void {
  g.__bosPaymentsLock = lock;
  locked = null;
}

let cached: PaymentsConfig | null = null;
let locked: { lock: PaymentsLock | null | undefined; config: PaymentsConfig } | null = null;

export function paymentsConfig(): PaymentsConfig {
  cached ??= readPaymentsConfig();
  const lock = g.__bosPaymentsLock;
  if (!locked || locked.lock !== lock) locked = { lock, config: applyLock(cached, lock ?? null) };
  return locked.config;
}

// Tests change the environment between cases.
export function resetPaymentsConfig(): void {
  cached = null;
  locked = null;
}

// The currencies that are on, in a fixed order.
export function enabledCurrencies(config: PaymentsConfig = paymentsConfig()): CurrencyConfig[] {
  return CURRENCIES.map((c) => config.currencies[c]).filter((c) => c.enabled);
}

// What the boot log says about payments: never a key, only what is on, what
// is off and why.
export function bootLines(config: PaymentsConfig): { level: "info" | "warn"; text: string }[] {
  const lines: { level: "info" | "warn"; text: string }[] = [];
  for (const w of config.warnings) lines.push({ level: "warn", text: `payments: ${w}` });
  for (const p of config.problems) lines.push({ level: "warn", text: `payments: ${p}` });
  if (config.enabled) {
    const on = enabledCurrencies(config).map((c) => c.code);
    lines.push({ level: "info", text: `payments: on, ${config.networkLabel} (chain ${config.chainId}), ${on.join(" and ")}.` });
  } else if (!config.treasury && config.problems.length === 0) {
    lines.push({ level: "info", text: "payments: off (TREASURY_ADDRESS is not set)." });
  }
  return lines;
}
