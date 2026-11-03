import "server-only";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { paymentSettings } from "../db/schema";
import { enabledCurrencies, type PaymentsConfig, type PaymentsLock } from "./config";

// A database's balances belong to one network and one token per currency.
// The first time payments run, the chain id and each enabled currency's
// token address are written down; after that, a config that points the same
// database at another chain (say Base Sepolia's balances meeting Base
// mainnet) turns payments off, and a currency whose token changed is turned
// off. A currency switched on later (SERV) is written down then.

const CHAIN_KEY = "bound_chain_id";
const tokenKey = (code: string) => `bound_token_${code}`;

async function bind(key: string, value: string): Promise<string> {
  await db.insert(paymentSettings).values({ key, value }).onConflictDoNothing({ target: paymentSettings.key });
  const [row] = await db.select({ value: paymentSettings.value }).from(paymentSettings).where(eq(paymentSettings.key, key)).limit(1);
  return row?.value ?? value;
}

export async function checkBinding(config: PaymentsConfig): Promise<PaymentsLock | null> {
  if (!config.enabled) return null;
  const chain = await bind(CHAIN_KEY, String(config.chainId));
  if (chain !== String(config.chainId)) {
    return {
      off: true,
      currencies: [],
      problems: [`This database holds balances on chain ${chain}, not ${config.chainId}. Payments are off: use a separate database for another network.`],
    };
  }
  const lock: PaymentsLock = { off: false, currencies: [], problems: [] };
  for (const c of enabledCurrencies(config)) {
    const token = c.token!.toLowerCase();
    const bound = await bind(tokenKey(c.code), token);
    if (bound !== token) {
      lock.currencies.push(c.code);
      lock.problems.push(`This database's ${c.code} balances are for token ${bound}, not ${token}. ${c.code} is off.`);
    }
  }
  return lock;
}
