"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { TopBar, TopLink } from "@/components/chat/TopBar";
import { ApprovalCard } from "@/components/agents/ApprovalCard";
import { privyAppId } from "@/lib/privy-config";
import type { ApprovalDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "../agents/agents.module.css";

// The questions the signed-in owner's agents wait on, and the ones answered.

const POLL_MS = 5_000;
export default function ApprovalsPage() {
  return (
    <div className={styles.page}>
      <TopBar agents={<TopLink href="/app/installations">Running for you</TopLink>} />
      <main className={styles.col}>
        <header className={styles.head}>
          <h1>Waiting for your answer</h1>
          <p className={styles.note}>a job waits on each until you answer</p>
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
      to answer your agents.
    </p>
  );
}

function List() {
  const api = useApi();
  const [list, setList] = useState<ApprovalDTO[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => api.listApprovals().then(setList, () => setFailed(true)), [api]);
  useEffect(() => {
    void load();
  }, [load]);
  // An answer given in Telegram shows here on the next look.
  const waiting = Boolean(list?.some((a) => a.status === "pending"));
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void api.listApprovals().then(setList, () => undefined), POLL_MS);
    return () => clearInterval(t);
  }, [api, waiting]);
  if (failed) return <p className={styles.quiet}>These could not load. Try again in a moment.</p>;
  if (!list) return <p className={styles.loading}>getting your questions</p>;
  if (!list.length) return <p className={styles.quiet}>Nothing waits for you.</p>;
  return (
    <ul className={styles.list}>
      {list.map((a) => (
        <li key={a.id}>
          <ApprovalCard
            approval={a}
            jobHref={`/app/jobs/${a.jobId}`}
            onAnswer={async (answer) => {
              await api.answerApproval(a.id, answer);
              await load();
            }}
          />
        </li>
      ))}
    </ul>
  );
}
