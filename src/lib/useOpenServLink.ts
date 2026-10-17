"use client";
import { useWallets, useSignMessage } from "@privy-io/react-auth";
import { useCallback } from "react";
import { useApi } from "./useApi";

// Link the signed-in user's OpenServ account. The embedded wallet signs the
// SIWE message OpenServ returns, in the browser. The signature goes to the
// server, which completes sign-in and stores the resulting key encrypted. We
// only ever use the plain embedded wallet (an EOA), never a smart wallet.
export function useOpenServLink() {
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const api = useApi();

  return useCallback(async (): Promise<void> => {
    const embedded = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
    if (!embedded) throw new Error("No embedded wallet is ready yet. Try again in a moment.");
    const address = embedded.address;
    const { message } = await api.linkStart(address);
    const result = (await signMessage({ message })) as unknown;
    const signature = typeof result === "string" ? result : (result as { signature: string }).signature;
    await api.linkFinish(address, message, signature);
  }, [wallets, signMessage, api]);
}
