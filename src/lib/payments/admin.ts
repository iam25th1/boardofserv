import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { base, baseSepolia } from "viem/chains";
import { db } from "../db";
import { balances, deposits, ledgerEntries, supportMessages, users, withdrawals, type User } from "../db/schema";
import type { Currency } from "../money";
import { dailySpendLimitUsd, nextReset, spendToday } from "../spend";
import { inviteOnly, waitingAccounts } from "../access";
import { codeFallbacks } from "../agents/build";
import type { AdminDTO, AdminWithdrawalDTO } from "../types";
import { chainError, type ChainClient } from "./chain";
import { enabledCurrencies, paymentsConfig, type PaymentsConfig } from "./config";
import { withdrawalDTO } from "./dto";
import { treasurySigner } from "./signer";
import { isStuck, payoutsPaused, type Withdrawal } from "./withdrawals";
import { agentPaymentsAdmin } from "../spending/admin";

// The admin page, for the users named in ADMIN_USER_IDS (by boardofserv user
// id or Privy user id). It shows today's model spend against the daily limit,
// and the treasury against what is owed: every
// user's balance (available and held) plus withdrawals asked for and not yet
// paid out. The difference is the platform's fees and anything unmatched,
// and must never go below zero. Users appear by handle only.

export function isAdmin(user: Pick<User, "id" | "privyUserId">, config: PaymentsConfig = paymentsConfig()): boolean {
  return config.adminUserIds.includes(user.id) || config.adminUserIds.includes(user.privyUserId);
}

// What the treasury owes in a currency: balances plus withdrawals that have
// left the balances but not the treasury. `mined` is what in-flight payouts
// already took out of the treasury (mined, not yet confirmed enough to be
// marked paid), so it isn't counted twice.
export async function owed(currency: Currency, chainId: number, mined = 0n): Promise<bigint> {
  const [b] = await db
    .select({ total: sql<string>`coalesce(sum(${balances.available} + ${balances.held}), 0)::text` })
    .from(balances)
    .where(eq(balances.currency, currency));
  const [w] = await db
    .select({ total: sql<string>`coalesce(sum(${withdrawals.amount}), 0)::text` })
    .from(withdrawals)
    .where(and(eq(withdrawals.currency, currency), eq(withdrawals.chainId, chainId), inArray(withdrawals.status, ["awaiting_approval", "queued", "broadcast"])));
  return BigInt(b?.total ?? "0") + BigInt(w?.total ?? "0") - mined;
}

async function fees(currency: Currency): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}::numeric), 0)::text` })
    .from(ledgerEntries)
    .where(and(inArray(ledgerEntries.kind, ["platform_fee", "platform_refund"]), eq(ledgerEntries.currency, currency)));
  return BigInt(row?.total ?? "0");
}

export async function adminDTO(chain: ChainClient, config: PaymentsConfig = paymentsConfig()): Promise<AdminDTO> {
  const treasury = config.treasury;
  // Payouts in flight that are already mined: the treasury has paid them.
  const mined: Partial<Record<Currency, bigint>> = {};
  const flying = await db
    .select()
    .from(withdrawals)
    .where(and(eq(withdrawals.chainId, config.chainId), eq(withdrawals.status, "broadcast")));
  for (const w of flying) {
    const r = w.txHash ? await chain.receipt(w.txHash as `0x${string}`).catch(() => null) : null;
    if (r?.status === "success") mined[w.currency] = (mined[w.currency] ?? 0n) + BigInt(w.amount);
  }
  const currencies: AdminDTO["currencies"] = [];
  for (const c of enabledCurrencies(config)) {
    const due = await owed(c.code, config.chainId, mined[c.code] ?? 0n);
    let held: bigint | null = null;
    let problem: string | null = null;
    try {
      if (treasury && c.token) held = await chain.tokenBalance(c.token, treasury);
    } catch (err) {
      problem = `The treasury balance could not be read: ${chainError(err)}`;
    }
    currencies.push({
      code: c.code,
      decimals: c.decimals,
      treasury: held?.toString() ?? null,
      owed: due.toString(),
      difference: held === null ? null : (held - due).toString(),
      fees: (await fees(c.code)).toString(),
      problem,
    });
  }

  const rows = await db
    .select({ w: withdrawals, maker: users.handle })
    .from(withdrawals)
    .innerJoin(users, eq(users.id, withdrawals.userId))
    .where(eq(withdrawals.chainId, config.chainId))
    .orderBy(desc(withdrawals.createdAt))
    .limit(100);
  const toDTO = async ({ w, maker }: { w: Withdrawal; maker: string }): Promise<AdminWithdrawalDTO> => {
    let stuck = false;
    if (w.status === "broadcast" && treasury) stuck = await isStuck(chain, w, treasury).catch(() => false);
    return { ...withdrawalDTO(w), maker, auto: w.auto, nonce: w.nonce, stuck };
  };
  const all = await Promise.all(rows.map(toDTO));

  const unmatched = await db
    .select()
    .from(deposits)
    .where(and(eq(deposits.chainId, config.chainId), eq(deposits.status, "unmatched")))
    .orderBy(desc(deposits.seenAt))
    .limit(100);

  const signer = treasurySigner(config);
  const now = new Date();
  return {
    access: { inviteOnly: inviteOnly(), waiting: await waitingAccounts() },
    spend: { today: await spendToday(now), limit: dailySpendLimitUsd(), resetsAt: nextReset(now).toISOString() },
    codeFallbacks: await codeFallbacks(now),
    support: (
      await db
        .select({ id: supportMessages.id, handle: users.handle, name: supportMessages.telegramName, text: supportMessages.text, at: supportMessages.createdAt })
        .from(supportMessages)
        .leftJoin(users, eq(users.id, supportMessages.userId))
        .orderBy(desc(supportMessages.createdAt))
        .limit(50)
    ).map((m) => ({ id: m.id, from: m.handle ? `@${m.handle}` : `${m.name ?? "someone"} on Telegram (not linked)`, text: m.text, at: m.at.toISOString() })),
    network: config.network,
    networkLabel: config.networkLabel,
    chainId: config.chainId,
    explorer: (config.network === "base" ? base : baseSepolia).blockExplorers.default.url,
    treasury,
    paused: await payoutsPaused(),
    signer: "problem" in signer ? signer.problem : null,
    currencies,
    agentPayments: await agentPaymentsAdmin(db, now),
    approvals: all.filter((w) => w.status === "awaiting_approval"),
    history: all.filter((w) => w.status !== "awaiting_approval"),
    unmatched: unmatched.map((d) => ({
      id: d.id,
      currency: d.currency,
      amount: d.amount,
      from: d.fromAddress,
      txHash: d.txHash,
      seenAt: d.seenAt.toISOString(),
    })),
  };
}
