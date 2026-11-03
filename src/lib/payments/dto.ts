import "server-only";
import { base, baseSepolia } from "viem/chains";
import type { PaymentsDTO, WalletDTO, WithdrawalDTO } from "../types";
import { enabledCurrencies, paymentsConfig, type PaymentsConfig } from "./config";
import { depositsOf } from "./deposits";
import { balancesOf } from "./ledger";
import { walletsOf } from "./wallets";
import { earnedOf, withdrawalsOf, type Withdrawal } from "./withdrawals";

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

export function withdrawalDTO(w: Withdrawal): WithdrawalDTO {
  return {
    id: w.id,
    currency: w.currency,
    amount: w.amount,
    to: w.toAddress,
    status: w.status,
    reason: w.reason,
    txHash: w.status === "failed" ? null : w.txHash,
    createdAt: w.createdAt.toISOString(),
  };
}

export async function walletDTO(userId: string, config: PaymentsConfig = paymentsConfig()): Promise<WalletDTO> {
  const [balances, earned, wallets, deposits, withdrawals] = await Promise.all([
    balancesOf(userId),
    earnedOf(userId),
    walletsOf(userId),
    depositsOf(userId),
    withdrawalsOf(userId),
  ]);
  const on = enabledCurrencies(config);
  return {
    balances: on.map((c) => ({ currency: c.code, available: balances[c.code].available.toString(), held: balances[c.code].held.toString() })),
    earned: on.map((c) => ({ currency: c.code, amount: earned[c.code].toString() })),
    wallets: wallets.map((w) => ({ address: w.address, embedded: w.embedded })),
    deposits: deposits.map((d) => ({ id: d.id, currency: d.currency, amount: d.amount.toString(), txHash: d.txHash, status: d.status, seenAt: d.seenAt.toISOString() })),
    withdrawals: withdrawals.map(withdrawalDTO),
  };
}
