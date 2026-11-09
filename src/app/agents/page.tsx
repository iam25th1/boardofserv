"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { TopBar, TopLink } from "@/components/chat/TopBar";
import { privyAppId } from "@/lib/privy-config";
import type { AgentListItemDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "./agents.module.css";

// The maker's own agents: each one's version, and "in testing" once a
// version is published. Not the board: agents aren't for renting yet.
export default function AgentsPage() {
  return (
    <div className={styles.page}>
      <TopBar agents={<TopLink href="/chat">Your agents</TopLink>} />
      <main className={styles.col}>
        <header className={styles.head}>
          <h1>Agents you&apos;re building</h1>
          <p className={styles.note}>only you see these</p>
        </header>
        {privyAppId() ? <SignedIn /> : <p className={styles.quiet}>Sign-in isn&apos;t set up here.</p>}
      </main>
    </div>
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
      to see your agents.
    </p>
  );
}

function List() {
  const api = useApi();
  const [agents, setAgents] = useState<AgentListItemDTO[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.listAgents().then(setAgents, () => setFailed(true));
  }, [api]);
  if (failed) return <p className={styles.quiet}>Your agents could not load. Try again in a moment.</p>;
  if (!agents) return <p className={styles.loading}>getting your agents</p>;
  if (!agents.length) {
    return (
      <p className={styles.quiet}>
        None yet. Describe one that runs on its own in <Link href="/chat">the chat</Link>, then press Plan.
      </p>
    );
  }
  return (
    <ul className={styles.list}>
      {agents.map((a) => (
        <li key={a.id}>
          <Link href={`/agents/${a.id}`} className={styles.card}>
            <strong>{a.name}</strong>
            <span className={styles.meta}>
              {a.steps} {a.steps === 1 ? "step" : "steps"}, version {a.version}
            </span>
            <span className={styles.chip} data-testing={a.testing ? "true" : "false"}>
              {a.testing ? `In testing, version ${a.testing}` : "Draft"}
              {a.testing && a.draft ? ", with a newer draft" : ""}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
