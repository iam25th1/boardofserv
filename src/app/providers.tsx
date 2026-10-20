"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { ToastProvider } from "@/components/ui";
import { LogoStrokes } from "@/components/chat/Wordmark";
import { palette } from "@/design/palette";
import { useResolvedTheme } from "@/lib/theme";

// App-wide client providers. Privy handles email login and gives every user a
// plain embedded Ethereum wallet (an EOA). We never enable smart wallets:
// FINDINGS.md shows OpenServ's SIWE would likely reject an ERC-1271 signer.
//
// Privy's modal follows the chalk theme as far as its config allows: the
// background is the current slate-2 (Privy derives its other surfaces from
// it), the accent is chalk, and the logo is the chalk mark. globals.css then
// pins Privy's CSS variables to the exact tokens and sets the font.
export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
  const theme = useResolvedTheme();
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
          theme: palette[theme]["slate-2"],
          accentColor: palette[theme].chalk,
          walletList: [],
          // Privy only accepts a bare <svg> or <img> here, and replaces its style.
          logo: (
            <svg viewBox="0 0 26 26" className="chalky privy-logo" aria-label="boardofserv">
              <LogoStrokes />
            </svg>
          ),
          landingHeader: "Sign in to boardofserv",
          loginMessage: "We email you a code. No wallet or crypto knowledge needed.",
        },
      }}
    >
      <ToastProvider>{children}</ToastProvider>
    </PrivyProvider>
  );
}
