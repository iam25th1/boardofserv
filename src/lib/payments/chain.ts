import "server-only";
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbiItem,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { paymentsConfig, type PaymentsConfig } from "./config";

// Everything payments ask of the chain, behind one interface: the watcher
// reads Transfer logs, payouts send signed transactions (signed elsewhere,
// see signer.ts: this client never holds a key), the admin page reads
// balances. Tests use a fake (src/test/fakeChain.ts) through setChainClient,
// so they never make an RPC call. The real client checks the endpoint's chain id before its first
// call and refuses to go on if it is not the configured network.

export interface TransferLog {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  from: Address;
  to: Address;
  value: bigint;
}

export interface ChainClient {
  readonly chainId: number;
  blockNumber(): Promise<bigint>;
  // ERC-20 Transfer logs of `token` to `to`, in the inclusive block range.
  transferLogs(q: { token: Address; to: Address; fromBlock: bigint; toBlock: bigint }): Promise<TransferLog[]>;
  tokenDecimals(token: Address): Promise<number>;
  tokenBalance(token: Address, owner: Address): Promise<bigint>;
  nativeBalance(owner: Address): Promise<bigint>;
  // How many transactions the address has sent: mined ("latest") or
  // including those waiting in the mempool ("pending").
  nonce(address: Address, blockTag: "latest" | "pending"): Promise<number>;
  // Gas and fees for an ERC-20 transfer of `amount` from `from` to `to`.
  transferFees(q: { token: Address; from: Address; to: Address; amount: bigint }): Promise<{ gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  // Send a signed transaction. Sending one the node already has is fine.
  sendRaw(raw: Hex): Promise<void>;
  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null>;
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export function viemChainClient(config: PaymentsConfig): ChainClient {
  const chain = config.network === "base" ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(config.rpcUrl ?? undefined, { timeout: 20_000, retryCount: 1 }) });
  let checked: Promise<void> | null = null;
  const ready = () => {
    checked ??= client.getChainId().then((id) => {
      if (id !== chain.id) {
        checked = null;
        throw new Error(`The RPC endpoint is on chain ${id}, not ${chain.name} (${chain.id}).`);
      }
    });
    return checked.catch((err) => {
      checked = null;
      throw err;
    });
  };

  return {
    chainId: chain.id,
    async blockNumber() {
      await ready();
      return client.getBlockNumber({ cacheTime: 0 });
    },
    async transferLogs({ token, to, fromBlock, toBlock }) {
      await ready();
      const logs = await client.getLogs({ address: token, event: TRANSFER, args: { to }, fromBlock, toBlock, strict: true });
      const out: TransferLog[] = [];
      for (const l of logs) {
        if (l.transactionHash === null || l.logIndex === null || l.blockNumber === null) continue;
        out.push({ txHash: l.transactionHash, logIndex: l.logIndex, blockNumber: l.blockNumber, from: l.args.from, to: l.args.to, value: l.args.value });
      }
      return out;
    },
    async tokenDecimals(token) {
      await ready();
      return client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
    },
    async tokenBalance(token, owner) {
      await ready();
      return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    },
    async nativeBalance(owner) {
      await ready();
      return client.getBalance({ address: owner });
    },
    async nonce(address, blockTag) {
      await ready();
      return client.getTransactionCount({ address, blockTag });
    },
    async transferFees({ token, from, to, amount }) {
      await ready();
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
      const [gas, fees] = await Promise.all([client.estimateGas({ account: from, to: token, data }), client.estimateFeesPerGas()]);
      // Headroom: a fifth more gas, twice the fee cap (only what is used is paid).
      return { gas: (gas * 6n) / 5n, maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    },
    async sendRaw(raw) {
      await ready();
      try {
        await client.sendRawTransaction({ serializedTransaction: raw });
      } catch (err) {
        // The node has it already, or it was mined: the same transaction.
        if (/already known|known transaction|nonce too low|already imported/i.test(chainError(err))) return;
        throw err;
      }
    },
    async receipt(hash) {
      await ready();
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber };
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      }
    },
  };
}

let current: ChainClient | null = null;

export function chainClient(): ChainClient {
  // A test that forgot its fake chain fails here instead of reaching an RPC.
  if (!current && process.env.VITEST) throw new Error("Tests use a fake chain: call setChainClient first.");
  current ??= viemChainClient(paymentsConfig());
  return current;
}

// Tests put a fake chain in place, and null puts the real one back.
export function setChainClient(client: ChainClient | null): void {
  current = client;
}

// An error as one line for the log: never a URL (an RPC endpoint can carry
// an API key in it), never a stack.
export function chainError(err: unknown): string {
  const e = err as { shortMessage?: unknown; message?: unknown; name?: unknown } | null;
  const text = typeof e?.shortMessage === "string" ? e.shortMessage : typeof e?.message === "string" ? e.message : String(e?.name ?? "unknown error");
  return text
    .split("\n")[0]!
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .slice(0, 200);
}
