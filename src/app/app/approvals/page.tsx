"use client";
import { useStaggerIn } from "@/lib/useStaggerIn";
import { SkeletonRows } from "@/components/ui";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { Page } from "@/components/shell/Page";
import { YourAgentsNav } from "@/components/shell/SubNav";
import { ApprovalCard } from "@/components/agents/ApprovalCard";
import { privyAppId } from "@/lib/privy-config";
import type { ApprovalDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "../agents/agents.module.css";

// The questions the signed-in owner's agents wait on, and the ones answered.

const POLL_MS = 5_000;
export default function ApprovalsPage() {
  return (
    <Page title="Waiting for your answer" note="a job waits on each until you answer" width="narrow" above={<YourAgentsNav />}>
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
      to answer your agents.
    </p>
  );
}

function List() {
  const api = useApi();
  const [list, setList] = useState<ApprovalDTO[] | null>(null);
  const [failed, setFailed] = useState(false);
  const listRef = useStaggerIn<HTMLUListElement>(Boolean(list?.length));
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
  if (!list) return <SkeletonRows label="Getting your questions" count={3} />;
  if (!list.length) return <p className={styles.quiet}>Nothing waits for you.</p>;
  return (
    <ul className={styles.list} ref={listRef}>
      {list.map((a) => (
        <li key={a.id} data-enter>
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
