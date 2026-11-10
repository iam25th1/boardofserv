import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { baseSepolia } from "viem/chains";
import { agentPayments, paymentAlerts, paymentSettings, withdrawals } from "../db/schema";
import type { Exec } from "../payments/ledger";
import type { PaymentsConfig } from "../payments/config";
import type { ChainClient } from "../payments/chain";
import type { PayoutSigner } from "../payments/signer";
import { parseAmount } from "../money";

// The treasury's sends, shared by agent payments and withdrawals: they come
// from one address, so one nonce. Only one send is in flight from it at a
// time (agent payment or withdrawal), decided under a database lock, and
// the next nonce is never below one already used by either. Agent payments
// run on Base Sepolia only; a mainnet chain, RPC or USDC address is refused
// unless AGENT_PAYMENTS_MAINNET=1, which this build never sets. They pause
// site wide when the treasury runs low, when an admin switches them off, or
// while a pausing alert is open.

// pg_advisory_xact_lock key for deciding the treasury's next send.
export const TREASURY_SEND_LOCK = 0x626f737472656173n; // "bostreas"

export async function lockTreasury(tx: Exec): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${TREASURY_SEND_LOCK.toString()}::bigint)`);
}

// A send from the treasury in flight on this chain: a withdrawal or an
// agent payment broadcast and not yet settled.
export async function treasuryBusy(tx: Exec, chainId: number): Promise<boolean> {
  const [w] = await tx.select({ id: withdrawals.id }).from(withdrawals).where(and(eq(withdrawals.chainId, chainId), eq(withdrawals.status, "broadcast"))).limit(1);
  if (w) return true;
  const [p] = await tx.select({ id: agentPayments.id }).from(agentPayments).where(and(eq(agentPayments.chainId, chainId), eq(agentPayments.status, "broadcast"))).limit(1);
  return Boolean(p);
}

// The treasury's next nonce: the chain's count of its mined transactions,
// never below one past the last nonce either kind of send used.
export async function nextNonce(tx: Exec, chain: ChainClient, signer: PayoutSigner, chainId: number): Promise<number> {
  const from = signer.address.toLowerCase();
  const [w] = await tx
    .select({ max: sql<number | null>`max(${withdrawals.nonce})` })
    .from(withdrawals)
    .where(and(eq(withdrawals.chainId, chainId), eq(withdrawals.fromAddress, from), inArray(withdrawals.status, ["paid", "reverted", "broadcast"])));
  const [p] = await tx
    .select({ max: sql<number | null>`max(${agentPayments.nonce})` })
    .from(agentPayments)
    .where(and(eq(agentPayments.chainId, chainId), eq(agentPayments.fromAddress, from), isNotNull(agentPayments.nonce), inArray(agentPayments.status, ["broadcast", "confirmed", "failed"])));
  const after = (m: number | null | undefined) => (m === null || m === undefined ? 0 : Number(m) + 1);
  return Math.max(await chain.nonce(signer.address, "latest"), after(w?.max), after(p?.max));
}

// Base Sepolia only, unless the explicit mainnet flag is set.
const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MAINNET_HOSTS = /mainnet\.base\.org|base-mainnet|base\.llamarpc|mainnet/i;

export function paymentsNetworkProblem(config: PaymentsConfig, env: Record<string, string | undefined> = process.env): string | null {
  if (!config.enabled || !config.treasury) return "Payments are off on this server.";
  const mainnetOk = env.AGENT_PAYMENTS_MAINNET?.trim() === "1";
  if (mainnetOk) return null;
  if (config.mainnet || config.chainId !== baseSepolia.id) return "Agent payments run on Base Sepolia only.";
  const token = config.currencies.USDC.token;
  if (!token || token.toLowerCase() !== SEPOLIA_USDC.toLowerCase()) return "Agent payments only send Base Sepolia's USDC.";
  if (config.rpcUrl && MAINNET_HOSTS.test(config.rpcUrl)) return "Agent payments won't use a mainnet RPC endpoint.";
  return null;
}

// What the treasury must keep after a payment (AGENT_PAYMENTS_MIN_TREASURY_USDC).
export function treasuryFloor(env: Record<string, string | undefined> = process.env): bigint {
  const raw = env.AGENT_PAYMENTS_MIN_TREASURY_USDC?.trim();
  const n = raw ? parseAmount(raw, 6) : null;
  return n !== null && n >= 0n ? n : 5_000_000n;
}

const PAUSED = "agent_payments_paused";

// Agent payments paused site wide: by an admin, by the treasury running
// low or by a mismatch, and why. Null when they run.
export async function paymentsPaused(exec: Exec): Promise<string | null> {
  const [row] = await exec.select({ value: paymentSettings.value }).from(paymentSettings).where(eq(paymentSettings.key, PAUSED)).limit(1);
  if (!row || row.value === "false") return null;
  return row.value === "true" ? "An admin paused agent payments." : row.value;
}

// Pause (with the reason renters and admins read) or let them run again,
// by an admin (their id) or by the system (null).
export async function setPaymentsPaused(exec: Exec, reason: string | null, by: string | null): Promise<void> {
  const value = reason === null ? "false" : reason;
  const who = by && /^[0-9a-f-]{36}$/i.test(by) ? by : null;
  await exec
    .insert(paymentSettings)
    .values({ key: PAUSED, value, updatedBy: who, updatedAt: new Date() })
    .onConflictDoUpdate({ target: paymentSettings.key, set: { value, updatedBy: who, updatedAt: new Date() } });
}

// An alert for the admin, once per key while it is open. Returns whether a
// new one was raised.
export async function raiseAlert(exec: Exec, a: { kind: string; key: string; message: string; details?: Record<string, unknown>; at: Date }): Promise<boolean> {
  const [row] = await exec
    .insert(paymentAlerts)
    .values({ kind: a.kind, key: a.key, message: a.message, details: a.details ?? {}, createdAt: a.at })
    .onConflictDoNothing()
    .returning({ id: paymentAlerts.id });
  return Boolean(row);
}

export async function resolveAlert(exec: Exec, id: string, adminId: string, resolution: string, at: Date): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [row] = await exec
    .update(paymentAlerts)
    .set({ status: "resolved", resolvedAt: at, resolvedBy: adminId, resolution, key: sql`${paymentAlerts.key} || ':resolved:' || ${at.getTime().toString()}` })
    .where(and(eq(paymentAlerts.id, id), eq(paymentAlerts.status, "open")))
    .returning({ id: paymentAlerts.id });
  return Boolean(row);
}

export const explorerTx = (chainId: number, hash: string) => (chainId === baseSepolia.id ? `https://sepolia.basescan.org/tx/${hash}` : `https://basescan.org/tx/${hash}`);
