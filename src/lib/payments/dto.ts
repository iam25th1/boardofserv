import "server-only";
import { base, baseSepolia } from "viem/chains";
import type { PaymentsDTO, WalletDTO } from "../types";
import { enabledCurrencies, paymentsConfig, type PaymentsConfig } from "./config";
import { depositsOf } from "./deposits";
import { balancesOf } from "./ledger";
import { walletsOf } from "./wallets";

// The shapes payments take in responses. Amounts leave as strings of digits.

export function paymentsDTO(config: PaymentsConfig = paymentsConfig()): PaymentsDTO {
  return {
    enabled: config.enabled,
    network: config.network,
    networkLabel: config.networkLabel,
    chainId: config.chainId,
    mainnet: config.mainnet,
    explorer: (config.network === "base" ? base : baseSepolia).blockExplorers.default.url,
    treasury: config.enabled ? config.treasury : null,
    confirmations: config.confirmations,
    currencies: config.enabled
      ? enabledCurrencies(config).map((c) => ({ code: c.code, decimals: c.decimals, token: c.token!, withdrawMin: c.withdrawMin?.toString() ?? null }))
      : [],
  };
}

export async function walletDTO(userId: string, config: PaymentsConfig = paymentsConfig()): Promise<WalletDTO> {
  const [balances, wallets, deposits] = await Promise.all([balancesOf(userId), walletsOf(userId), depositsOf(userId)]);
  return {
    balances: enabledCurrencies(config).map((c) => ({ currency: c.code, available: balances[c.code].available.toString(), held: balances[c.code].held.toString() })),
    wallets: wallets.map((w) => ({ address: w.address, embedded: w.embedded })),
    deposits: deposits.map((d) => ({ id: d.id, currency: d.currency, amount: d.amount.toString(), txHash: d.txHash, status: d.status, seenAt: d.seenAt.toISOString() })),
  };
}
