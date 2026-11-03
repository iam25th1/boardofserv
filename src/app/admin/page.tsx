"use client";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { TopBar, TopLink } from "@/components/chat/TopBar";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";
import { AdminBody } from "./AdminView";
import styles from "./admin.module.css";

// Payments admin, for the users named in ADMIN_USER_IDS: the treasury
// against what it owes, withdrawals waiting for approval, unmatched
// deposits, payout history, and the switch that pauses every payout.

export default function AdminPage() {
  return (
    <div className={styles.page}>
      <TopBar agents={<TopLink href="/chat">Your agents</TopLink>} />
      <main className={styles.col}>
        <header className={styles.head}>
          <h1>Payments admin</h1>
        </header>
        {privyAppId() ? <SignedIn /> : <p className={styles.quiet}>Sign-in isn&apos;t set up here.</p>}
      </main>
    </div>
  );
}

function SignedIn() {
  const { ready, authenticated } = usePrivy();
  if (ready && authenticated) return <Admin />;
  return (
    <p className={styles.quiet}>
      <Link href="/login?next=%2Fadmin" aria-disabled={!ready}>
        Sign in
      </Link>{" "}
      to see this page.
    </p>
  );
}

function Admin() {
  const api = useApi();
  return <AdminBody api={api} />;
}
