import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex } from "viem";
import type { ChainClient, TransferLog } from "@/lib/payments/chain";

// A chain in memory for the payments tests: blocks, ERC-20 balances and
// Transfer logs, nonces, a mempool of signed transactions (really signed,
// decoded here) mined in nonce order, receipts, and every call recorded. No
// RPC call is ever made.

interface Pending {
  raw: Hex;
  hash: Hex;
  from: Address;
  nonce: number;
  token: Address;
  to: Address;
  amount: bigint;
}

export const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

let hashes = 0;
export const newHash = (): Hex => `0x${(++hashes).toString(16).padStart(64, "0")}` as Hex;

export class FakeChain implements ChainClient {
  readonly chainId: number;
  head = 1000n;
  readonly decimals = new Map<string, number>();
  readonly balances = new Map<string, bigint>();
  logs: (TransferLog & { token: Address })[] = [];
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly native = new Map<string, bigint>();
  readonly mined = new Map<string, number>();
  readonly receipts = new Map<string, { status: "success" | "reverted"; blockNumber: bigint }>();
  mempool: Pending[] = [];
  // Every raw transaction ever sent, resends included.
  readonly sent: Hex[] = [];
  // The next mined payout reverts.
  revertNext = false;
  // sendRaw fails like a network error.
  sendFails = false;
  private logIndex = 0;

  constructor(chainId = 84532) {
    this.chainId = chainId;
  }

  private key(token: Address, owner: Address): string {
    return `${token.toLowerCase()}:${owner.toLowerCase()}`;
  }

  setDecimals(token: Address, d: number): void {
    this.decimals.set(token.toLowerCase(), d);
  }

  setBalance(token: Address, owner: Address, value: bigint): void {
    this.balances.set(this.key(token, owner), value);
  }

  // A token transfer in a block (the newest by default). Returns its log.
  transfer(token: Address, from: Address, to: Address, value: bigint, block = this.head): TransferLog {
    const log = { token, txHash: newHash(), logIndex: this.logIndex++, blockNumber: block, from, to, value };
    this.logs.push(log);
    const fromKey = this.key(token, from);
    this.balances.set(fromKey, (this.balances.get(fromKey) ?? 0n) - value);
    const toKey = this.key(token, to);
    this.balances.set(toKey, (this.balances.get(toKey) ?? 0n) + value);
    return log;
  }

  // Mine n blocks; the first takes the mempool's transactions, in nonce order.
  mine(n = 1): void {
    this.head += 1n;
    for (const tx of [...this.mempool].sort((a, b) => a.nonce - b.nonce)) {
      if ((this.mined.get(tx.from.toLowerCase()) ?? 0) !== tx.nonce) continue;
      this.mined.set(tx.from.toLowerCase(), tx.nonce + 1);
      this.mempool = this.mempool.filter((p) => p !== tx);
      const funded = (this.balances.get(this.key(tx.token, tx.from)) ?? 0n) >= tx.amount;
      if (this.revertNext || !funded) {
        this.revertNext = false;
        this.receipts.set(tx.hash, { status: "reverted", blockNumber: this.head });
        continue;
      }
      this.transfer(tx.token, tx.from, tx.to, tx.amount, this.head);
      this.receipts.set(tx.hash, { status: "success", blockNumber: this.head });
    }
    this.head += BigInt(n - 1);
  }

  // Someone else uses the address's next nonce (a transaction we never sent).
  useNonce(address: Address): void {
    const k = address.toLowerCase();
    this.mined.set(k, (this.mined.get(k) ?? 0) + 1);
    this.mempool = this.mempool.filter((p) => !(p.from.toLowerCase() === k && p.nonce < (this.mined.get(k) ?? 0)));
  }

  // A reorg: the log is gone.
  drop(txHash: Hex): void {
    this.logs = this.logs.filter((l) => l.txHash !== txHash);
  }

  async blockNumber(): Promise<bigint> {
    this.calls.push({ method: "blockNumber", args: [] });
    return this.head;
  }

  async transferLogs(q: { token: Address; to: Address; fromBlock: bigint; toBlock: bigint }): Promise<TransferLog[]> {
    this.calls.push({ method: "transferLogs", args: [q] });
    return this.logs
      .filter((l) => l.token.toLowerCase() === q.token.toLowerCase() && l.to.toLowerCase() === q.to.toLowerCase())
      .filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock && l.blockNumber <= this.head)
      .map(({ token: _token, ...log }) => log);
  }

  async tokenDecimals(token: Address): Promise<number> {
    this.calls.push({ method: "tokenDecimals", args: [token] });
    return this.decimals.get(token.toLowerCase()) ?? 6;
  }

  async tokenBalance(token: Address, owner: Address): Promise<bigint> {
    this.calls.push({ method: "tokenBalance", args: [token, owner] });
    return this.balances.get(this.key(token, owner)) ?? 0n;
  }

  async nativeBalance(owner: Address): Promise<bigint> {
    this.calls.push({ method: "nativeBalance", args: [owner] });
    return this.native.get(owner.toLowerCase()) ?? 10n ** 18n;
  }

  async nonce(address: Address, blockTag: "latest" | "pending"): Promise<number> {
    this.calls.push({ method: "nonce", args: [address, blockTag] });
    const mined = this.mined.get(address.toLowerCase()) ?? 0;
    if (blockTag === "latest") return mined;
    return mined + this.mempool.filter((p) => p.from.toLowerCase() === address.toLowerCase()).length;
  }

  async transferFees(q: { token: Address; from: Address; to: Address; amount: bigint }) {
    this.calls.push({ method: "transferFees", args: [q] });
    return { gas: 60_000n, maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000_000n };
  }

  async sendRaw(raw: Hex): Promise<void> {
    this.calls.push({ method: "sendRaw", args: [raw] });
    if (this.sendFails) throw new Error("fetch failed");
    this.sent.push(raw);
    const hash = keccak256(raw);
    if (this.receipts.has(hash) || this.mempool.some((p) => p.hash === hash)) return;
    const tx = parseTransaction(raw);
    if (tx.chainId !== this.chainId) throw new Error(`wrong chain id ${tx.chainId}`);
    const from = await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
    const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    const [to, amount] = args as [Address, bigint];
    // viem leaves out a nonce of 0 when it parses.
    const nonce = tx.nonce ?? 0;
    // The real client treats "nonce too low" as already sent, so does this.
    if ((this.mined.get(from.toLowerCase()) ?? 0) > nonce) return;
    this.mempool.push({ raw, hash, from, nonce, token: tx.to!, to, amount });
  }

  async receipt(hash: Hex) {
    this.calls.push({ method: "receipt", args: [hash] });
    const r = this.receipts.get(hash);
    return r && r.blockNumber <= this.head ? r : null;
  }
}
