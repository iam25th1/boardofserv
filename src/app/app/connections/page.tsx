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
import { ServKeyCard } from "@/components/connections/ServKeyCard";
import { useShellAccount } from "@/components/shell/AccountContext";
import { backTo } from "@/lib/backTo";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";
import styles from "../agents/agents.module.css";

// The signed-in owner's connections: every service of the catalog.
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
// that card opens and is brought into view, and once it is connected the
// page goes back to where it was asked from.
function useConnectHere(): { which: string | null; back: string | null } {
  const [here, setHere] = useState<{ which: string | null; back: string | null }>({ which: null, back: null });
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setHere({ which: q.get("connect"), back: backTo(q.get("back")) });
  }, []);
  return here;
}

function Connections() {
  const api = useApi();
  const { account, refresh } = useShellAccount();
  const back = useGoogleReturn();
  const here = useConnectHere();
  const view: ConnectionsApi = useMemo(() => ({ load: api.listConnections, disconnect: api.disconnect, connect: api.connectService, setWrites: api.setWrites }), [api]);
  const goBack = async (provider: string) => {
    if (here.back && provider === here.which) window.location.assign(here.back);
  };
  return (
    <>
      {back && (
        <p className={styles.note} role="status">
          {back}
        </p>
      )}
      {account && (
        <ServKeyCard
          servKey={account.servKey ?? null}
          onSave={async (key) => {
            await api.setServKey(key);
            await refresh();
          }}
          onRemove={async () => {
            await api.removeServKey();
            await refresh();
          }}
        />
      )}
      <ConnectionsView
        api={view}
        focus={here.which}
        onConnected={goBack}
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
