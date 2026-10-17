"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { ToastProvider } from "@/components/ui";

// App-wide client providers. Privy handles email login and gives every user a
// plain embedded Ethereum wallet (an EOA). We never enable smart wallets:
// FINDINGS.md shows OpenServ's SIWE would likely reject an ERC-1271 signer.
export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
  // Without an app id (for example during a CI build) Privy cannot initialise,
  // so render without it. The auth pages are dynamic and only reach this path
  // at runtime, where the app id is set.
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
