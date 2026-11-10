import "server-only";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Address } from "viem";
import { agentPayments, allowanceEntries, ledgerEntries, paymentAlerts, paymentSettings, withdrawals } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import { raiseAlert, setPaymentsPaused } from "./treasury";
import { usdcWords } from "./allowance";

// Reconciliation: every agent payment in the ledger matched with its
// transfer on Base, and every transfer from the treasury matched with a
// send we made (an agent payment or a withdrawal). A confirmed payment with
// no transfer, a transfer of another amount or to another address, a
// payment whose ledger charge or allowance spend is missing or wrong, or a
// transfer from the treasury nobody made here: any of them pauses agent
// payments site wide and puts an alert in the admin queue with the details.
//
// The chain is read from a checkpoint (the block it reached last time),
// in spans the public RPC accepts. The first run starts at the head (or
// AGENT_RECONCILE_START_BLOCK), so what the treasury sent before agent
// payments existed isn't counted against them.

const CHECKPOINT = "agent_reconcile_block";
const SPAN = 200n;
const PER_RUN = 25;

export interface Mismatch {
  kind: "missing_transfer" | "wrong_amount" | "wrong_address" | "ledger" | "unknown_transfer";
  key: string;
  message: string;
  details: Record<string, unknown>;
}

async function checkpoint(rt: Runtime): Promise<bigint | null> {
  const [row] = await rt.db.select({ value: paymentSettings.value }).from(paymentSettings).where(eq(paymentSettings.key, CHECKPOINT));
  return row?.value && /^\d+$/.test(row.value) ? BigInt(row.value) : null;
}

async function setCheckpoint(rt: Runtime, block: bigint): Promise<void> {
  const v = block.toString();
  await rt.db
    .insert(paymentSettings)
    .values({ key: CHECKPOINT, value: v, updatedAt: rt.now() })
    .onConflictDoUpdate({ target: paymentSettings.key, set: { value: v, updatedAt: rt.now() } });
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

// One pass. Returns the mismatches it found (each already alerted, and
// payments paused when there are any).
export async function reconcile(rt: Runtime, env: Record<string, string | undefined> = process.env): Promise<Mismatch[]> {
  const pay = rt.payments;
  if (!pay?.config.enabled || !pay.config.treasury) return [];
  const token = pay.config.currencies.USDC.token as Address;
  const treasury = pay.config.treasury;
  const chainId = pay.config.chainId;
  const head = await pay.chain.blockNumber();
  const confirmed = head - BigInt(Math.max(pay.config.confirmations, 1)) + 1n;
  const found: Mismatch[] = [];

  // The chain's side: every transfer from the treasury, since the checkpoint.
  let from = await checkpoint(rt);
  if (from === null) {
    const start = env.AGENT_RECONCILE_START_BLOCK?.trim();
    from = start && /^\d+$/.test(start) ? BigInt(start) : confirmed + 1n;
    await setCheckpoint(rt, from - 1n);
  } else from += 1n;
  const logs: Awaited<ReturnType<typeof pay.chain.transferLogsFrom>> = [];
  let to = from - 1n;
  for (let i = 0; i < PER_RUN && to < confirmed; i++) {
    const end = to + SPAN < confirmed ? to + SPAN : confirmed;
    logs.push(...(await pay.chain.transferLogsFrom({ token, from: treasury, fromBlock: to + 1n, toBlock: end })));
    to = end;
  }
  const hashes = [...new Set(logs.map((l) => l.txHash.toLowerCase()))];
  const ours = hashes.length ? await rt.db.select().from(agentPayments).where(and(eq(agentPayments.chainId, chainId), inArray(sql`lower(${agentPayments.txHash})`, hashes))) : [];
  const theirs = hashes.length ? await rt.db.select({ txHash: withdrawals.txHash, amount: withdrawals.amount, to: withdrawals.toAddress }).from(withdrawals).where(and(eq(withdrawals.chainId, chainId), inArray(sql`lower(${withdrawals.txHash})`, hashes))) : [];
  for (const l of logs) {
    const p = ours.find((x) => x.txHash?.toLowerCase() === l.txHash.toLowerCase());
    if (p) {
      if (BigInt(p.amount) !== l.value) found.push({ kind: "wrong_amount", key: `wrong_amount:${l.txHash}`, message: `An agent payment of ${usdcWords(BigInt(p.amount))} went out on chain as ${usdcWords(l.value)}.`, details: { paymentId: p.id, txHash: l.txHash, ledger: p.amount, chain: l.value.toString() } });
      if (p.toAddress.toLowerCase() !== l.to.toLowerCase()) found.push({ kind: "wrong_address", key: `wrong_address:${l.txHash}`, message: `An agent payment to ${p.payeeLabel} (${short(p.toAddress)}) went to ${short(l.to)} on chain.`, details: { paymentId: p.id, txHash: l.txHash, payee: p.toAddress, chain: l.to } });
      continue;
    }
    if (theirs.some((w) => w.txHash?.toLowerCase() === l.txHash.toLowerCase())) continue;
    found.push({ kind: "unknown_transfer", key: `unknown_transfer:${l.txHash}:${l.logIndex}`, message: `${usdcWords(l.value)} left the treasury to ${short(l.to)} in a transfer no payment or withdrawal here made.`, details: { txHash: l.txHash, to: l.to, value: l.value.toString(), block: l.blockNumber.toString() } });
  }
  if (to >= from) await setCheckpoint(rt, to);

  // The ledger's side: every confirmed payment has its transfer, its
  // ledger charge and its allowance spend, each for its amount.
  const settled = await rt.db
    .select()
    .from(agentPayments)
    .where(and(eq(agentPayments.chainId, chainId), eq(agentPayments.status, "confirmed"), isNotNull(agentPayments.txHash), isNull(agentPayments.reconciledAt)))
    .limit(50);
  for (const p of settled) {
    const r = await pay.chain.receipt(p.txHash as `0x${string}`);
    if (!r || r.status !== "success") {
      found.push({ kind: "missing_transfer", key: `missing_transfer:${p.id}`, message: `An agent payment of ${usdcWords(BigInt(p.amount))} to ${p.payeeLabel} is confirmed here but its transfer isn't on chain.`, details: { paymentId: p.id, txHash: p.txHash } });
      continue;
    }
    const block = p.blockNumber ? BigInt(p.blockNumber) : r.blockNumber;
    const onChain = await pay.chain.transferLogsFrom({ token, from: treasury, fromBlock: block, toBlock: block });
    const log = onChain.find((l) => l.txHash.toLowerCase() === p.txHash!.toLowerCase());
    if (!log) found.push({ kind: "missing_transfer", key: `missing_transfer:${p.id}`, message: `An agent payment of ${usdcWords(BigInt(p.amount))} to ${p.payeeLabel} has a mined transaction but no USDC transfer from the treasury.`, details: { paymentId: p.id, txHash: p.txHash } });
    else {
      if (log.value !== BigInt(p.amount)) found.push({ kind: "wrong_amount", key: `wrong_amount:${log.txHash}`, message: `An agent payment of ${usdcWords(BigInt(p.amount))} went out on chain as ${usdcWords(log.value)}.`, details: { paymentId: p.id, txHash: log.txHash, ledger: p.amount, chain: log.value.toString() } });
      if (log.to.toLowerCase() !== p.toAddress.toLowerCase()) found.push({ kind: "wrong_address", key: `wrong_address:${log.txHash}`, message: `An agent payment to ${p.payeeLabel} (${short(p.toAddress)}) went to ${short(log.to)} on chain.`, details: { paymentId: p.id, txHash: log.txHash, payee: p.toAddress, chain: log.to } });
    }
    const [charge] = await rt.db.select({ amount: ledgerEntries.amount }).from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `agentpay:${p.id}`));
    const [spend] = await rt.db.select({ amount: allowanceEntries.amount }).from(allowanceEntries).where(eq(allowanceEntries.key, `payment:${p.id}:spend`));
    if (!charge || BigInt(charge.amount) !== -BigInt(p.amount) || !spend || BigInt(spend.amount) !== BigInt(p.amount)) {
      found.push({ kind: "ledger", key: `ledger:${p.id}`, message: `An agent payment of ${usdcWords(BigInt(p.amount))} to ${p.payeeLabel} went out, but its ledger charge or allowance spend is missing or wrong.`, details: { paymentId: p.id, charge: charge?.amount ?? null, spend: spend?.amount ?? null } });
    }
    // Matched: not looked at again.
    if (!found.some((f) => (f.details as { paymentId?: string }).paymentId === p.id)) {
      await rt.db.update(agentPayments).set({ reconciledAt: rt.now() }).where(eq(agentPayments.id, p.id));
    }
  }

  // The same problem seen from both sides is one.
  const unique = found.filter((m, i) => found.findIndex((x) => x.key === m.key) === i);
  found.length = 0;
  found.push(...unique);
  const now = rt.now();
  let raised = 0;
  for (const m of found) if (await raiseAlert(rt.db, { kind: m.kind, key: m.key, message: m.message, details: m.details, at: now })) raised += 1;
  if (found.length) await setPaymentsPaused(rt.db, "A payment and its transfer on chain don't match, so agent payments wait for an admin.", null);
  if (raised) rt.log(`payments: reconciliation found ${raised} ${raised === 1 ? "mismatch" : "mismatches"}; agent payments are paused.`);
  return found;
}

// The admin's view of it: when it last ran up to, and the open alerts.
export async function reconcileStatus(rt: Runtime) {
  const block = await checkpoint(rt);
  const open = await rt.db.select().from(paymentAlerts).where(eq(paymentAlerts.status, "open"));
  return { block: block?.toString() ?? null, open };
}
