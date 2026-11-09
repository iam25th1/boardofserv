"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { TopBar, TopLink } from "@/components/chat/TopBar";
import { ConnectionsView, type ConnectionsApi } from "@/components/connections/ConnectionsView";
import { GoogleConnect } from "@/components/connections/GoogleConnect";
import { TelegramLink } from "@/components/connections/TelegramLink";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";
import styles from "../agents/agents.module.css";

// The signed-in owner's connections to Telegram and Google.
export default function ConnectionsPage() {
  return (
    <div className={styles.page}>
      <TopBar agents={<TopLink href="/app/installations">Running for you</TopLink>} />
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

// Back from Google: how it went, from the address, said once.
function useGoogleReturn(): string | null {
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const how = q.get("google");
    if (!how) return;
    setSaid(how === "connected" ? "Google is connected." : (q.get("why") ?? "Google wasn't connected.").slice(0, 300));
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  return said;
}

function Connections() {
  const api = useApi();
  const back = useGoogleReturn();
  const view: ConnectionsApi = useMemo(() => ({ load: api.listConnections, disconnect: api.disconnect }), [api]);
  return (
    <>
      {back && (
        <p className={styles.note} role="status">
          {back}
        </p>
      )}
      <ConnectionsView
        api={view}
        connect={{
          telegram: (refresh) => <TelegramLink getCode={api.telegramCode} refresh={refresh} />,
          google: () => <GoogleConnect start={api.googleStart} />,
        }}
      />
    </>
  );
}
