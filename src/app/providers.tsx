"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { ToastProvider } from "@/components/ui";
import { privyAppId } from "@/lib/privy-config";

// App-wide client providers. Privy handles email login and gives every user a
// plain embedded Ethereum wallet (an EOA). We never enable smart wallets:
// FINDINGS.md shows OpenServ's SIWE would likely reject an ERC-1271 signer.
export function Providers({ children }: { children: React.ReactNode }) {
  const appId = privyAppId();
  // Without a usable app id (for example the CI build) Privy cannot start, so
  // it is not mounted. The sign-in and chat pages then show SignInUnset.
  if (!appId) return <ToastProvider>{children}</ToastProvider>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        embeddedWallets: {
          ethereum: { createOnLogin: "all-users" },
        },
        appearance: {
          theme: "light",
          accentColor: "#12685c",
          walletList: [],
          logo: undefined,
        },
      }}
    >
      <ToastProvider>{children}</ToastProvider>
    </PrivyProvider>
  );
}
