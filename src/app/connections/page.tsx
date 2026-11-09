"use client";
import { useMemo } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { TopBar, TopLink } from "@/components/chat/TopBar";
import { ConnectionsView, type ConnectionsApi } from "@/components/connections/ConnectionsView";
import { TelegramLink } from "@/components/connections/TelegramLink";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";
import styles from "../agents/agents.module.css";

// The signed-in owner's connections to Telegram and Google.
export default function ConnectionsPage() {
  return (
    <div className={styles.page}>
      <TopBar agents={<TopLink href="/installations">Running for you</TopLink>} />
      <main className={styles.col}>
        <header className={styles.head}>
          <h1>Connections</h1>
          <p className={styles.note}>what your agents may reach, and only for you</p>
        </header>
        {privyAppId() ? <SignedIn /> : <p className={styles.quiet}>Sign-in isn&apos;t set up here.</p>}
      </main>
    </div>
  );
}

function SignedIn() {
  const { ready, authenticated } = usePrivy();
  if (ready && authenticated) return <Connections />;
  return (
    <p className={styles.quiet}>
      <Link href="/login" aria-disabled={!ready}>
        Sign in
      </Link>{" "}
      to see your connections.
    </p>
  );
}

function Connections() {
  const api = useApi();
  const view: ConnectionsApi = useMemo(() => ({ load: api.listConnections, disconnect: api.disconnect }), [api]);
  return <ConnectionsView api={view} connect={{ telegram: (refresh) => <TelegramLink getCode={api.telegramCode} refresh={refresh} /> }} />;
}
