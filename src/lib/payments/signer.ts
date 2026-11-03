import "server-only";
import { encodeFunctionData, erc20Abi, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { PaymentsConfig } from "./config";

// The payout signer: the only code that reads TREASURY_PRIVATE_KEY. It signs
// an ERC-20 transfer locally and returns the signed bytes and their hash, so
// the hash is recorded before anything is sent and a resend is the very same
// transaction. The key never leaves this module: not in a return value, an
// error or a log.

export interface PayoutSigner {
  readonly address: Address;
  signTransfer(q: {
    chainId: number;
    token: Address;
    to: Address;
    amount: bigint;
    nonce: number;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }): Promise<{ raw: Hex; hash: Hex }>;
}

export function signerFromKey(key: Hex): PayoutSigner {
  const account: PrivateKeyAccount = privateKeyToAccount(key);
  return {
    address: account.address,
    async signTransfer(q) {
      const raw = await account.signTransaction({
        type: "eip1559",
        chainId: q.chainId,
        to: q.token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [q.to, q.amount] }),
        value: 0n,
        nonce: q.nonce,
        gas: q.gas,
        maxFeePerGas: q.maxFeePerGas,
        maxPriorityFeePerGas: q.maxPriorityFeePerGas,
      });
      return { raw, hash: keccak256(raw) };
    },
  };
}

// The treasury's signer, or why there is none: no key, a key that is not
// one, or a key for another address than TREASURY_ADDRESS.
export function treasurySigner(config: PaymentsConfig, env: Record<string, string | undefined> = process.env): PayoutSigner | { problem: string } {
  const raw = env.TREASURY_PRIVATE_KEY?.trim();
  if (!raw) return { problem: "TREASURY_PRIVATE_KEY is not set, so payouts can't be sent." };
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return { problem: "TREASURY_PRIVATE_KEY is not a private key, so payouts can't be sent." };
  let signer: PayoutSigner;
  try {
    signer = signerFromKey(key);
  } catch {
    return { problem: "TREASURY_PRIVATE_KEY is not a private key, so payouts can't be sent." };
  }
  if (!config.treasury || signer.address.toLowerCase() !== config.treasury.toLowerCase()) {
    return { problem: "TREASURY_PRIVATE_KEY belongs to another address than TREASURY_ADDRESS, so payouts can't be sent." };
  }
  return signer;
}
