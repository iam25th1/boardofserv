"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { TopBar, TopLink } from "@/components/chat/TopBar";
import { privyAppId } from "@/lib/privy-config";
import type { InstallationDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "../../agents/agents.module.css";

// One agent running for its owner.
export default function InstallationPage({ params }: { params: { id: string } }) {
  return (
    <div className={styles.page}>
      <TopBar agents={<TopLink href="/installations">Running for you</TopLink>} />
      <main className={styles.col}>{privyAppId() ? <SignedIn id={params.id} /> : <p className={styles.quiet}>Sign-in isn&apos;t set up here.</p>}</main>
    </div>
  );
}

function SignedIn({ id }: { id: string }) {
  const { ready, authenticated } = usePrivy();
  if (ready && authenticated) return <Detail id={id} />;
  return (
    <p className={styles.quiet}>
      <Link href="/login" aria-disabled={!ready}>
        Sign in
      </Link>{" "}
      to see this.
    </p>
  );
}

function Detail({ id }: { id: string }) {
  const api = useApi();
  const [data, setData] = useState<InstallationDTO | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api.getInstallation(id).then(setData, () => setMissing(true));
  }, [api, id]);
  if (missing) return <p className={styles.quiet}>Nothing here.</p>;
  if (!data) return <p className={styles.loading}>getting it</p>;
  return (
    <>
      <header className={styles.head}>
        <h1>{data.name}</h1>
        <p className={styles.quiet}>
          version {data.version}, {data.status}, times in {data.timezone}
        </p>
      </header>
      <ul className={styles.list}>
        {data.settings.map((s) => (
          <li key={s.key} className={styles.card}>
            <strong>{s.label}</strong>
            <span className={styles.meta}>{Array.isArray(s.value) ? s.value.join(", ") : String(s.value ?? "")}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
