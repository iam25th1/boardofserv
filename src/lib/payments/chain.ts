import "server-only";
import { createPublicClient, erc20Abi, http, parseAbiItem, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { paymentsConfig, type PaymentsConfig } from "./config";

// Everything payments ask of the chain, behind one interface: the watcher
// reads Transfer logs, the admin page reads balances. Tests use a fake
// (src/test/fakeChain.ts) through setChainClient, so they never make an RPC
// call. The real client checks the endpoint's chain id before its first
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
  };
}

let current: ChainClient | null = null;

export function chainClient(): ChainClient {
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
