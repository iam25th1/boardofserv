import "server-only";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Address } from "viem";
import { db } from "../db";
import { chainCursors, deposits, linkedWallets, users } from "../db/schema";
import { privyWalletOwner } from "../privy";
import { enabledCurrencies, paymentsConfig, type CurrencyConfig, type PaymentsConfig } from "./config";
import { chainClient, chainError, type ChainClient, type TransferLog } from "./chain";
import { post, type Exec } from "./ledger";
import { ownerOf } from "./wallets";
import type { Currency } from "../money";

// The deposit watcher. For each enabled currency it reads the token's
// Transfer logs to the treasury, from the block after the last one it
// finished (kept in chain_cursors, so a restart resumes there) up to the
// newest block with enough confirmations. A transfer from a wallet linked to
// a user credits that user once: the deposit row is unique per chain id,
// transaction hash and log index, and so is the ledger row's idempotency key.
// A transfer from any other wallet is recorded as unmatched, credited to
// nobody, for the admin page. Transfers in blocks too new to count are
// recorded as confirming, so the user sees them arrive.
//
// Credits and the cursor move in one transaction per block range, so a crash
// part way never skips a range or credits one twice. Each scan also reads
// the last RESCAN_BLOCKS below the cursor again (settling is idempotent), so
// a node that answered one query with stale, empty logs can't make a
// deposit be missed for good.
//
// Who sent it is decided by Privy when Privy is set up: the sender's wallet
// must be linked to the user right now. The stored copy of linked wallets is
// updated from the answer. Without Privy (tests, a bare development setup)
// the stored copy decides. If Privy can't be asked, nothing in that range is
// settled and the scan tries again next time.

// At most this many log queries per currency per scan, so one scan stays
// short even when the cursor is far behind; the next scan carries on.
const MAX_RANGES_PER_SCAN = 25;
export const RESCAN_BLOCKS = 120n;

// The user a sending wallet belongs to, or null.
export type OwnerLookup = (address: string) => Promise<string | null>;

export function defaultOwnerLookup(): OwnerLookup {
  if (!process.env.PRIVY_APP_SECRET || !process.env.NEXT_PUBLIC_PRIVY_APP_ID) return (address) => ownerOf(db, address);
  return async (address) => {
    const privyId = await privyWalletOwner(address);
    if (!privyId) return null;
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.privyUserId, privyId)).limit(1);
    if (!user) return null;
    await db
      .insert(linkedWallets)
      .values({ address: address.toLowerCase(), userId: user.id })
      .onConflictDoUpdate({ target: linkedWallets.address, set: { userId: user.id } });
    return user.id;
  };
}

// Asks once per address per scan.
function cached(lookup: OwnerLookup): OwnerLookup {
  const known = new Map<string, Promise<string | null>>();
  return (address) => {
    const k = address.toLowerCase();
    if (!known.has(k)) known.set(k, lookup(k));
    return known.get(k)!;
  };
}

export interface ScanReport {
  currency: Currency;
  // The last block now scanned, null when the currency was skipped.
  scannedTo: bigint | null;
  credited: number;
  unmatched: number;
}

// Each token's decimals are checked against the chain once per process
// before anything is credited in it; a mismatch keeps that currency off.
const decimalsChecked = new Map<string, boolean>();

async function decimalsOk(chain: ChainClient, c: CurrencyConfig): Promise<boolean> {
  const key = `${chain.chainId}:${c.token}`;
  const known = decimalsChecked.get(key);
  if (known !== undefined) return known;
  const onChain = await chain.tokenDecimals(c.token!);
  const ok = onChain === c.decimals;
  if (!ok) console.error(`payments: ${c.code} token says ${onChain} decimals, config says ${c.decimals}. ${c.code} deposits are not credited until they match.`);
  decimalsChecked.set(key, ok);
  return ok;
}

export function cursorKey(chainId: number, token: Address): string {
  return `deposits:${chainId}:${token.toLowerCase()}`;
}

async function readCursor(key: string): Promise<bigint | null> {
  const [row] = await db.select({ block: chainCursors.block }).from(chainCursors).where(eq(chainCursors.key, key)).limit(1);
  return row?.block ?? null;
}

async function writeCursor(tx: Exec, key: string, block: bigint): Promise<void> {
  await tx
    .insert(chainCursors)
    .values({ key, block, updatedAt: new Date() })
    // Never backwards, if two scans overlap.
    .onConflictDoUpdate({ target: chainCursors.key, set: { block: sql`greatest(${chainCursors.block}, ${block.toString()}::bigint)`, updatedAt: new Date() } });
}

export function depositKey(chainId: number, log: Pick<TransferLog, "txHash" | "logIndex">): string {
  return `deposit:${chainId}:${log.txHash.toLowerCase()}:${log.logIndex}`;
}

// A transfer with enough confirmations: credit its sender's user, or record
// it as unmatched. Nothing happens to a log already settled.
async function settle(tx: Exec, config: PaymentsConfig, c: CurrencyConfig, log: TransferLog, userId: string | null): Promise<"credited" | "unmatched" | null> {
  const status = userId ? "credited" : "unmatched";
  const [row] = await tx
    .insert(deposits)
    .values({
      chainId: config.chainId,
      txHash: log.txHash.toLowerCase(),
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      currency: c.code,
      fromAddress: log.from.toLowerCase(),
      amount: log.value.toString(),
      userId,
      status,
      settledAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [deposits.chainId, deposits.txHash, deposits.logIndex],
      set: { status, userId, blockNumber: log.blockNumber, settledAt: new Date() },
      // Only a log not settled yet: one seen while confirming, or one a
      // reorg dropped and brought back.
      setWhere: inArray(deposits.status, ["confirming", "dropped"]),
    })
    .returning({ id: deposits.id });
  if (!row) return null;
  if (userId) {
    await post(tx, { userId, currency: c.code, kind: "deposit", amount: log.value, referenceId: row.id, key: depositKey(config.chainId, log) });
  }
  return status;
}

// A transfer in a block too new to count: shown to its sender as confirming.
async function seen(config: PaymentsConfig, c: CurrencyConfig, log: TransferLog, userId: string | null): Promise<void> {
  await db
    .insert(deposits)
    .values({
      chainId: config.chainId,
      txHash: log.txHash.toLowerCase(),
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      currency: c.code,
      fromAddress: log.from.toLowerCase(),
      amount: log.value.toString(),
      userId,
      status: "confirming",
    })
    .onConflictDoNothing();
}

// Transfers worth recording: a positive amount, not from the treasury itself.
function counts(log: TransferLog, treasury: Address): boolean {
  return log.value > 0n && log.from.toLowerCase() !== treasury.toLowerCase();
}

export async function scanOnce(chain: ChainClient, config: PaymentsConfig, lookup: OwnerLookup = defaultOwnerLookup()): Promise<ScanReport[]> {
  const treasury = config.treasury;
  if (!config.enabled || !treasury) return [];
  const owner = cached(lookup);
  const head = await chain.blockNumber();
  // A block's own confirmation is the first, so `confirmations` deep means
  // head - confirmations + 1 or older.
  const safe = head - BigInt(config.confirmations) + 1n;
  const reports: ScanReport[] = [];

  for (const c of enabledCurrencies(config)) {
    const report: ScanReport = { currency: c.code, scannedTo: null, credited: 0, unmatched: 0 };
    reports.push(report);
    if (!c.token || !(await decimalsOk(chain, c))) continue;
    const key = cursorKey(config.chainId, c.token);
    const cursor = await readCursor(key);
    const first = cursor === null ? (config.startBlock ?? (safe > 0n ? safe : 0n)) : cursor + 1n;
    // Read the last stretch below the cursor again, in case a node answered
    // it with stale logs; anything already settled is left as it is.
    const floor = config.startBlock ?? 0n;
    let from = cursor === null ? first : cursor - RESCAN_BLOCKS + 1n > floor ? cursor - RESCAN_BLOCKS + 1n : floor;
    let scannedTo = cursor;

    for (let i = 0; i < MAX_RANGES_PER_SCAN && from <= safe; i++) {
      const to = from + config.scanChunk - 1n < safe ? from + config.scanChunk - 1n : safe;
      const logs = (await chain.transferLogs({ token: c.token, to: treasury, fromBlock: from, toBlock: to })).filter((l) => counts(l, treasury));
      // Asked before the transaction: a network call never holds it open.
      const owners = await Promise.all(logs.map((l) => owner(l.from)));
      await db.transaction(async (tx) => {
        for (const [i, log] of logs.entries()) {
          const done = await settle(tx, config, c, log, owners[i]!);
          if (done === "credited") report.credited++;
          else if (done === "unmatched") report.unmatched++;
        }
        await writeCursor(tx, key, to);
      });
      scannedTo = scannedTo === null || to > scannedTo ? to : scannedTo;
      from = to + 1n;
    }
    report.scannedTo = scannedTo;

    // Too new to count yet: seen, not credited. Only once caught up, so the
    // range stays a handful of blocks.
    if (from > safe && safe < head) {
      const tail = await chain.transferLogs({ token: c.token, to: treasury, fromBlock: safe + 1n > 0n ? safe + 1n : 0n, toBlock: head });
      for (const log of tail.filter((l) => counts(l, treasury))) await seen(config, c, log, await owner(log.from));
    }
    // Still confirming below everything that will be read again: a reorg
    // took it away. (A later scan that finds it after all brings it back.)
    if (scannedTo !== null && scannedTo >= RESCAN_BLOCKS) {
      await db
        .update(deposits)
        .set({ status: "dropped", settledAt: new Date() })
        .where(
          and(
            eq(deposits.chainId, config.chainId),
            eq(deposits.currency, c.code),
            eq(deposits.status, "confirming"),
            lte(deposits.blockNumber, scannedTo - RESCAN_BLOCKS),
          ),
        );
    }
  }
  return reports;
}

// One scan at a time in this process: a second caller waits for the running
// one, then runs its own, so a deposit that just confirmed is always seen.
let running: Promise<ScanReport[]> | null = null;

export async function scanDeposits(): Promise<ScanReport[]> {
  while (running) await running.catch(() => undefined);
  const scan = scanOnce(chainClient(), paymentsConfig());
  running = scan;
  try {
    return await scan;
  } finally {
    if (running === scan) running = null;
  }
}

// The scan the server runs on an interval. Errors go to the log as one line.
export async function scanTick(): Promise<void> {
  try {
    await scanDeposits();
  } catch (err) {
    console.error(`payments: deposit scan failed: ${chainError(err)}`);
  }
}

export interface UserDeposit {
  id: string;
  currency: Currency;
  amount: bigint;
  txHash: string;
  status: "confirming" | "credited" | "dropped";
  seenAt: Date;
}

// A user's recent deposits from their linked wallets, newest first.
export async function depositsOf(userId: string, limit = 20): Promise<UserDeposit[]> {
  const rows = await db
    .select({ id: deposits.id, currency: deposits.currency, amount: deposits.amount, txHash: deposits.txHash, status: deposits.status, seenAt: deposits.seenAt })
    .from(deposits)
    .where(and(eq(deposits.userId, userId), inArray(deposits.status, ["confirming", "credited", "dropped"])))
    .orderBy(desc(deposits.seenAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, amount: BigInt(r.amount), status: r.status as UserDeposit["status"] }));
}
