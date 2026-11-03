// The testnet smoke test, run by hand by the owner: npm run testnet-smoke
//
// Base Sepolia only: it refuses to run on any other network, and the RPC
// endpoint must answer with chain id 84532. It checks the treasury's test
// USDC and ETH, prints the deposit address, waits for one USDC deposit from a
// wallet linked to a boardofserv account (crediting it through the app's own
// deposit watcher), then sends one tiny withdrawal back to that wallet through
// the app's own payout path: debited in the ledger, signed, its hash recorded,
// sent once, and reconciled. It prints transaction hashes, never a key, and
// never the database or RPC address (either can carry a secret).
//
// It reads .env.local like the app does. It needs DATABASE_URL (the app's
// database, migrated), TREASURY_ADDRESS, TREASURY_PRIVATE_KEY, and
// SMOKE_FROM: the linked wallet the owner sends from. Only a deposit from
// that wallet counts, and the withdrawal goes back to it, so nobody else's
// money is ever touched. SMOKE_WITHDRAW_USDC sets the withdrawal (default
// 0.01) and SMOKE_TIMEOUT_MINUTES how long to wait for the deposit (default
// 30).

import { existsSync } from "node:fs";
import { and, asc, eq, gte } from "drizzle-orm";
import { formatEther } from "viem";
import { db } from "@/lib/db";
import { deposits, linkedWallets, withdrawals } from "@/lib/db/schema";
import { formatAmount, parseAmount } from "@/lib/money";
import { chainError, viemChainClient, type ChainClient } from "@/lib/payments/chain";
import { applyLock, readPaymentsConfig } from "@/lib/payments/config";
import { checkBinding } from "@/lib/payments/binding";
import { scanOnce } from "@/lib/payments/deposits";
import { treasurySigner } from "@/lib/payments/signer";
import { payoutsPaused, reconcilePayouts, requestWithdrawal, sendNextPayout } from "@/lib/payments/withdrawals";

const BASE_SEPOLIA = 84532;
const EXPLORER = "https://sepolia.basescan.org";

// What a test swaps out: the chain (a fake one), where lines go, and the
// waits. The owner's run uses the real ones.
export interface SmokeDeps {
  chain?: ChainClient;
  say?: (line?: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function runSmoke(deps: SmokeDeps = {}): Promise<number> {
  const say = deps.say ?? ((line = "") => console.log(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!deps.chain && existsSync(".env.local")) process.loadEnvFile(".env.local");

  const env = readPaymentsConfig();
  const network = (process.env.BOS_NETWORK ?? "").trim() || "base-sepolia";
  if (network !== "base-sepolia" || env.chainId !== BASE_SEPOLIA || env.mainnet || process.env.BOS_MAINNET?.trim()) {
    say("Refused: the smoke test runs on Base Sepolia only. Unset BOS_MAINNET and set BOS_NETWORK=base-sepolia (or leave it unset).");
    return 1;
  }
  const sender = process.env.SMOKE_FROM?.trim().toLowerCase() ?? "";
  if (!/^0x[0-9a-f]{40}$/.test(sender)) {
    say("Set SMOKE_FROM to the linked wallet you will send the test USDC from. Only its deposit counts, and the withdrawal goes back to it.");
    return 1;
  }
  // The same database binding as the app: never another network's balances.
  const config = applyLock(env, env.enabled ? await checkBinding(env) : null);
  for (const p of config.problems) say(`Config: ${p}`);
  const usdc = config.currencies.USDC;
  if (!config.enabled || !config.treasury || !usdc.enabled || !usdc.token) {
    say("Payments are off: set TREASURY_ADDRESS (and keep USDC on) in .env.local.");
    return 1;
  }
  const treasury = config.treasury;
  const token = usdc.token;
  const fmt = (units: bigint) => `${formatAmount(units, usdc.decimals)} USDC`;

  // The first call checks that the RPC endpoint is on chain 84532.
  const chain = deps.chain ?? viemChainClient(config);
  const head = await chain.blockNumber();
  say(`Network: Base Sepolia (chain ${chain.chainId}), block ${head}`);
  if (chain.chainId !== BASE_SEPOLIA) return 1;

  const signer = treasurySigner(config);
  if ("problem" in signer) {
    say(signer.problem);
    return 1;
  }
  const onChainDecimals = await chain.tokenDecimals(token);
  if (onChainDecimals !== usdc.decimals) {
    say(`The USDC token says ${onChainDecimals} decimals, the config ${usdc.decimals}. Fix USDC_DECIMALS first.`);
    return 1;
  }
  const [held, gas] = await Promise.all([chain.tokenBalance(token, treasury), chain.nativeBalance(treasury)]);
  say(`Treasury: ${treasury}`);
  say(`  test USDC: ${fmt(held)}`);
  say(`  ETH for gas: ${formatEther(gas)}`);
  if (gas === 0n) say("  The treasury has no ETH: the withdrawal can't pay for gas. Get some from a Base Sepolia faucet first.");
  if (await payoutsPaused()) {
    say("Payouts are paused on the admin page. Resume them, then run this again.");
    return 1;
  }

  const [linked] = await db.select({ userId: linkedWallets.userId }).from(linkedWallets).where(eq(linkedWallets.address, sender));
  say(`Sender: ${sender}, ${linked ? "linked to a boardofserv account" : "not linked here yet"}`);
  if (!linked) say("  Link it on /wallet before you send, or the deposit is credited to nobody.");

  say();
  say("Deposit address (Base Sepolia, USDC only):");
  say(`  ${treasury}`);
  say(`  USDC token: ${token}`);
  say(`Send a little test USDC (1 USDC is plenty) to it from ${sender}.`);
  say(`Waiting for ${config.confirmations} confirmations once it lands. Ctrl+C stops.`);
  say();

  const since = new Date(Date.now() - 60_000);
  const minutes = Number(process.env.SMOKE_TIMEOUT_MINUTES) > 0 ? Number(process.env.SMOKE_TIMEOUT_MINUTES) : 30;
  const deadline = Date.now() + minutes * 60_000;
  const told = new Set<string>();
  let credited: typeof deposits.$inferSelect | undefined;
  while (!credited && Date.now() < deadline) {
    try {
      await scanOnce(chain, config);
    } catch (err) {
      say(`  scan failed, trying again: ${chainError(err)}`);
    }
    const seen = await db
      .select()
      .from(deposits)
      .where(and(eq(deposits.chainId, config.chainId), eq(deposits.currency, "USDC"), eq(deposits.fromAddress, sender), gte(deposits.seenAt, since)))
      .orderBy(asc(deposits.seenAt));
    for (const d of seen) {
      const note = `${d.id}:${d.status}`;
      if (told.has(note)) continue;
      told.add(note);
      if (d.status === "confirming") say(`  seen ${fmt(BigInt(d.amount))} in ${d.txHash}, confirming`);
      if (d.status === "unmatched") say(`  ${fmt(BigInt(d.amount))} arrived, but ${d.fromAddress} isn't linked to anyone: credited to nobody. Link it on /wallet and send again.`);
      if (d.status === "dropped") say(`  ${d.txHash} was dropped by a reorg`);
    }
    credited = seen.find((d) => d.status === "credited" && d.userId);
    if (!credited) await sleep(10_000);
  }
  if (!credited || !credited.userId) {
    say("No deposit from a linked wallet arrived in time.");
    return 1;
  }
  say(`Deposit credited: ${fmt(BigInt(credited.amount))}`);
  say(`  deposit tx: ${credited.txHash}`);
  say(`  ${EXPLORER}/tx/${credited.txHash}`);

  const asked = parseAmount(process.env.SMOKE_WITHDRAW_USDC?.trim() || "0.01", usdc.decimals);
  if (asked === null || asked <= 0n) {
    say("SMOKE_WITHDRAW_USDC is not an amount.");
    return 1;
  }
  const amount = asked < BigInt(credited.amount) ? asked : BigInt(credited.amount);
  const w = await requestWithdrawal(
    { userId: credited.userId, currency: "USDC", amount, to: credited.fromAddress, key: `smoke:${credited.id}` },
    { approvedBy: null, ignoreMinimum: true },
    config,
  );
  say();
  say(`Withdrawal of ${fmt(amount)} back to ${credited.fromAddress}, approved by this run.`);

  const payDeadline = Date.now() + 10 * 60_000;
  let shown = false;
  while (Date.now() < payDeadline) {
    await reconcilePayouts(chain, config);
    let [row] = await db.select().from(withdrawals).where(eq(withdrawals.id, w.id));
    if (row?.status === "queued") {
      await sendNextPayout(chain, signer, config);
      [row] = await db.select().from(withdrawals).where(eq(withdrawals.id, w.id));
    }
    if (!row) return 1;
    if (row.txHash && !shown) {
      shown = true;
      say(`  payout tx: ${row.txHash} (nonce ${row.nonce}), sent`);
      say(`  ${EXPLORER}/tx/${row.txHash}`);
    }
    if (row.status === "paid") {
      say(`Paid, with ${config.confirmations} confirmations. The smoke test passed.`);
      return 0;
    }
    if (row.status === "reverted" || row.status === "failed" || row.status === "rejected") {
      say(`The payout ${row.status}; the amount went back to the balance.`);
      return 1;
    }
    await sleep(5_000);
  }
  say("The payout wasn't confirmed within ten minutes. The app keeps reconciling it; see /admin.");
  return 1;
}

// Run when started by npm run testnet-smoke, not when a test imports it.
if (!process.env.VITEST) {
  runSmoke().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`The smoke test stopped: ${chainError(err)}`);
      process.exit(1);
    },
  );
}
