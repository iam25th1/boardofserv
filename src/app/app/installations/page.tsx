"use client";
import { useStaggerIn } from "@/lib/useStaggerIn";
import { SkeletonRows } from "@/components/ui";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { Page } from "@/components/shell/Page";
import { YourAgentsNav } from "@/components/shell/SubNav";
import { Controls, Glance } from "@/components/agents/InstallationControls";
import { privyAppId } from "@/lib/privy-config";
import type { InstallationDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "../agents/agents.module.css";

// The agents running for the signed-in owner.
export default function InstallationsPage() {
  return (
    <Page title="Running for you" note="only you see these" width="wide" above={<YourAgentsNav />}>
      {privyAppId() ? <SignedIn /> : <p className={styles.quiet}>Sign-in isn&apos;t set up here.</p>}
    </Page>
  );
}

function SignedIn() {
  const { ready, authenticated } = usePrivy();
  if (ready && authenticated) return <List />;
  return (
    <p className={styles.quiet}>
      <Link href="/login" aria-disabled={!ready}>
        Sign in
      </Link>{" "}
      to see what runs for you.
    </p>
  );
}

function List() {
  const api = useApi();
  const [list, setList] = useState<InstallationDTO[] | null>(null);
  const [failed, setFailed] = useState(false);
  const listRef = useStaggerIn<HTMLUListElement>(Boolean(list?.length));
  useEffect(() => {
    api.listInstallations().then(setList, () => setFailed(true));
  }, [api]);
  if (failed) return <p className={styles.quiet}>These could not load. Try again in a moment.</p>;
  if (!list) return <SkeletonRows label="Getting what runs for you" count={3} />;
  if (!list.length) {
    return (
      <p className={styles.quiet}>
        Nothing yet. Publish one of <Link href="/app/agents">your agents</Link>, then press Run it for real.
      </p>
    );
  }
  return (
    <ul className={styles.list} ref={listRef}>
      {list.map((i) => (
        <li key={i.id} className={styles.panel} data-enter>
          <div className={styles.panelHead}>
            <Link href={`/app/installations/${i.id}`}>
              <strong>{i.name}</strong>
            </Link>
            <span className={styles.meta}>
              version {i.version}, {i.runs.join("; ").toLowerCase()}
            </span>
            <span className={styles.chip} data-testing={i.status === "active" ? "true" : "false"}>
              {i.status}
            </span>
          </div>
          <Glance data={i} />
          <Controls
            data={i}
            onControl={async (action) => {
              const next = await api.controlInstallation(i.id, action);
              setList((all) => all?.map((x) => (x.id === next.id ? next : x)) ?? null);
            }}
          />
        </li>
      ))}
    </ul>
  );
}
