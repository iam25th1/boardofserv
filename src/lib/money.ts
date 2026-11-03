// Money is an integer count of a token's smallest unit (minor units), held as
// a BigInt and sent over JSON as a string of digits. A number never stands
// for an amount: every function here refuses one, so a float can't slip into
// a balance by accident. Shared by the browser (to show and read amounts) and
// the server.

export const CURRENCIES = ["USDC", "SERV"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function isCurrency(x: unknown): x is Currency {
  return typeof x === "string" && (CURRENCIES as readonly string[]).includes(x);
}

// The amount itself, or a TypeError when it is anything but a BigInt.
export function minor(x: unknown): bigint {
  if (typeof x !== "bigint") throw new TypeError("Money must be a BigInt of minor units, never a number.");
  return x;
}

// A whole number of minor units sent as a string (a balance or price in a
// response), or null when it is not one.
export function fromDigits(text: unknown): bigint | null {
  return typeof text === "string" && /^-?\d{1,78}$/.test(text) ? BigInt(text) : null;
}

// "12.5" in a token with `decimals` decimals, as minor units. Null for
// anything else: a sign, an exponent, more decimals than the token has.
export function parseAmount(text: string, decimals: number): bigint | null {
  const m = /^(\d{1,40})(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

// Minor units as a decimal string: 12500000 in a 6 decimal token is "12.50".
// Trailing zeros go, but at least `minFraction` decimals stay.
export function formatAmount(units: bigint, decimals: number, minFraction = 2): string {
  const n = minor(units);
  const sign = n < 0n ? "-" : "";
  const digits = (n < 0n ? -n : n).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  let frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  frac = frac.padEnd(Math.min(minFraction, decimals), "0");
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

// A paid use: 90% to the maker, 10% to the platform. The maker's share is
// rounded down, so any remainder goes to the platform and the two always add
// up to the price.
export const MAKER_PERCENT = 90n;

export function splitCharge(price: bigint): { maker: bigint; platform: bigint } {
  const p = minor(price);
  if (p <= 0n) throw new RangeError("A price must be more than zero.");
  const maker = (p * MAKER_PERCENT) / 100n;
  return { maker, platform: p - maker };
}
