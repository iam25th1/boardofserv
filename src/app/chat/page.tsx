"use client";
export const dynamic = "force-dynamic";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { ChatShell } from "@/components/chat/ChatShell";
import { Wordmark } from "@/components/chat/Wordmark";
import styles from "./chat.module.css";

export default function ChatPage() {
  const { ready, authenticated } = usePrivy();
  const router = useRouter();

  useEffect(() => {
    if (ready && !authenticated) router.replace("/login");
  }, [ready, authenticated, router]);

  if (!ready || !authenticated) {
    return (
      <main className={styles.loading}>
        <Wordmark />
        <p className={styles.loadingText}>Getting your workspace ready</p>
      </main>
    );
  }
  return <ChatShell />;
}
