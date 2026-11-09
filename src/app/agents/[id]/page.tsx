"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { TopBar, TopLink } from "@/components/chat/TopBar";
import { AgentBuilder, type BuilderApi } from "@/components/agents/AgentBuilder";
import { privyAppId } from "@/lib/privy-config";
import type { AgentBuilderDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "../agents.module.css";

// An agent's builder and test bench, for its maker only.
export default function AgentPage({ params }: { params: { id: string } }) {
  return (
    <div className={styles.page}>
      <TopBar agents={<TopLink href="/chat">Your agents</TopLink>} />
      <main className={styles.col}>{privyAppId() ? <SignedIn id={params.id} /> : <p className={styles.quiet}>Sign-in isn&apos;t set up here.</p>}</main>
    </div>
  );
}

function SignedIn({ id }: { id: string }) {
  const { ready, authenticated } = usePrivy();
  if (ready && authenticated) return <Builder id={id} />;
  return (
    <p className={styles.quiet}>
      <Link href="/login" aria-disabled={!ready}>
        Sign in
      </Link>{" "}
      to see this agent.
    </p>
  );
}

function Builder({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [data, setData] = useState<AgentBuilderDTO | null>(null);
  const [missing, setMissing] = useState(false);
  const builderApi = useMemo<BuilderApi>(
    () => ({
      load: () => api.getAgentBuilder(id),
      run: (body, on) => api.runAgent(id, body, on),
      fix: (message) => api.fixAgent(id, message),
      saveBench: (bench) => api.saveAgentBench(id, bench),
      publish: () => api.publishAgent(id),
      install: async (answers) => {
        const installed = await api.installAgent(id, answers);
        router.push(`/installations/${installed.id}`);
      },
    }),
    [api, id, router],
  );
  useEffect(() => {
    builderApi.load().then(setData, () => setMissing(true));
  }, [builderApi]);
  if (missing) return <p className={styles.quiet}>Nothing here.</p>;
  if (!data) return <p className={styles.loading}>getting the agent</p>;
  return <AgentBuilder initial={data} api={builderApi} />;
}
