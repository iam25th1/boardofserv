"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { Page } from "@/components/shell/Page";
import { YourAgentsNav } from "@/components/shell/SubNav";
import { ConnectionsView, type ConnectionsApi } from "@/components/connections/ConnectionsView";
import { GoogleConnect } from "@/components/connections/GoogleConnect";
import { TelegramLink } from "@/components/connections/TelegramLink";
import { TypeformConnect } from "@/components/connections/TypeformConnect";
import { backTo } from "@/lib/backTo";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";
import styles from "../agents/agents.module.css";

// The signed-in owner's connections to Telegram, Google and Typeform.
export default function ConnectionsPage() {
  return (
    <Page title="Connections" note="what your agents may reach, and only for you" width="narrow" above={<YourAgentsNav />}>
      {privyAppId() ? <SignedIn /> : <p className={styles.quiet}>Sign-in isn&apos;t set up here.</p>}
    </Page>
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

// Sent here to connect one service (?connect=typeform&back=/app/chat?c=...):
// that card is brought into view, and once it is connected the page goes
// back to where it was asked from.
function useConnectHere(): { back: string | null } {
  const [back, setBack] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const which = q.get("connect");
    setBack(backTo(q.get("back")));
    if (which) setTimeout(() => document.getElementById(`connect-${which}`)?.scrollIntoView({ block: "center" }), 400);
  }, []);
  return { back };
}

function Connections() {
  const api = useApi();
  const back = useGoogleReturn();
  const here = useConnectHere();
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
          typeform: (refresh) => (
            <TypeformConnect
              connect={api.connectTypeform}
              onConnected={async () => {
                if (here.back) window.location.assign(here.back);
                else await refresh();
              }}
            />
          ),
        }}
      />
    </>
  );
}
