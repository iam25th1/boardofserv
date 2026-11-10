import "server-only";
import { z } from "zod";
import { CURRENCIES, type Currency } from "../money";
import { priceProblem } from "./uses";

// Prices as a request carries them: per currency, a whole number of minor
// units as a string of digits, or null (or "0") to stop accepting it.
export const PricesBody = z.partialRecord(z.enum(CURRENCIES), z.string().regex(/^\d{1,78}$/).nullable());

export function readPrices(body: Partial<Record<Currency, string | null>>): { prices: Partial<Record<Currency, bigint | null>> } | { error: string } {
  const prices: Partial<Record<Currency, bigint | null>> = {};
  for (const currency of CURRENCIES) {
    if (!(currency in body)) continue;
    const raw = body[currency];
    const amount = raw === null || raw === undefined ? 0n : BigInt(raw);
    if (amount === 0n) {
      prices[currency] = null;
      continue;
    }
    const problem = priceProblem(currency, amount);
    if (problem) return { error: problem };
    prices[currency] = amount;
  }
  return { prices };
}
