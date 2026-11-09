"use client";
import { SkeletonPanel } from "@/components/ui";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { Page } from "@/components/shell/Page";
import { YourAgentsNav } from "@/components/shell/SubNav";
import { InstallationView, type InstallationApi } from "@/components/agents/InstallationView";
import { privyAppId } from "@/lib/privy-config";
import type { InstallationDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "../../agents/agents.module.css";

// One agent running for its owner.
export default function InstallationPage({ params }: { params: { id: string } }) {
  return (
    <Page width="wide" above={<YourAgentsNav />}>
      {privyAppId() ? <SignedIn id={params.id} /> : <p className={styles.quiet}>Sign-in isn&apos;t set up here.</p>}
    </Page>
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
  const view = useMemo<InstallationApi>(
    () => ({
      load: () => api.getInstallation(id),
      messages: () => api.listAgentMessages(id),
      send: (text) => api.messageAgent(id, text),
      control: (action) => api.controlInstallation(id, action),
      answer: async (approvalId, answer) => void (await api.answerApproval(approvalId, answer)),
    }),
    [api, id],
  );
  useEffect(() => {
    view.load().then(setData, () => setMissing(true));
  }, [view]);
  if (missing) return <p className={styles.quiet}>Nothing here.</p>;
  if (!data) return <SkeletonPanel label="Getting it" lines={7} />;
  return <InstallationView initial={data} api={view} />;
}
