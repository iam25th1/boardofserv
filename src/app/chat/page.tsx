"use client";
export const dynamic = "force-dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { ChatShell } from "@/components/chat/ChatShell";
import { Wordmark } from "@/components/chat/Wordmark";
import { SignInUnset } from "@/components/SignInUnset";
import { Waitlist } from "@/components/Waitlist";
import { privyAppId } from "@/lib/privy-config";
import type { AccountDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "./chat.module.css";

export default function ChatPage() {
  // No Privy app id means no sign-in, so there is no chat to reach.
  if (!privyAppId()) return <SignInUnset />;
  return <SignedInChat />;
}

function SignedInChat() {
  const { ready, authenticated } = usePrivy();
  const router = useRouter();

  useEffect(() => {
    // The query string rides along, so a flag like ?sketch=demo survives sign in.
    if (ready && !authenticated) router.replace(`/login${window.location.search}`);
  }, [ready, authenticated, router]);

  if (!ready || !authenticated) return <Loading />;
  return <LetIn />;
}

function Loading() {
  return (
    <main className={styles.loading}>
      <Wordmark />
      <p className={styles.loadingText}>getting your workspace ready</p>
    </main>
  );
}

// Invite-only: the account decides between the chat and the waitlist. If it
// can't be read, the chat opens and the server still turns a waiting
// account away.
function LetIn() {
  const api = useApi();
  const { logout } = usePrivy();
  const [account, setAccount] = useState<AccountDTO | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api.getAccount().then(
      (a) => live && setAccount(a),
      () => live && setAccount(null),
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (account === undefined) return <Loading />;
  if (account?.access === "waiting" || account?.access === "rejected") {
    return <Waitlist access={account.access} email={account.email} onSignOut={() => void logout()} />;
  }
  return <ChatShell initialAccount={account} />;
}
