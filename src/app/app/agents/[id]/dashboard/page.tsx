"use client";
import { useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { SkeletonPanel } from "@/components/ui";
import { Page } from "@/components/shell/Page";
import { MakerDashboard, type MakerDashboardApi } from "@/components/market/MakerDashboard";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";

// The maker's dashboard for their agent on the board.
export default function DashboardPage() {
  // Next 16 passes params to a page as a promise; a client page reads them here.
  const params = useParams<{ id: string }>();
  if (!privyAppId()) return <Page title="On the board">Sign-in isn&apos;t set up here.</Page>;
  return <SignedIn id={params.id} />;
}

function SignedIn({ id }: { id: string }) {
  const { ready, authenticated } = usePrivy();
  if (!ready) {
    return (
      <Page width="wide">
        <SkeletonPanel label="Getting how it does" lines={8} />
      </Page>
    );
  }
  if (!authenticated) {
    return (
      <Page title="On the board">
        <Link href={`/login?next=${encodeURIComponent(`/app/agents/${id}/dashboard`)}`}>Sign in</Link> to see how your agent does.
      </Page>
    );
  }
  return <Dashboard id={id} />;
}

function Dashboard({ id }: { id: string }) {
  const api = useApi();
  const runs = useCallback(() => api.listAgentJobs(id), [api, id]);
  const dashApi = useMemo<MakerDashboardApi>(() => ({ load: () => api.getMakerDashboard(id), runs, kill: (action, note) => api.killAgent(id, action, note), audit: (before) => api.makerAudit(id, before) }), [api, id, runs]);
  return <MakerDashboard id={id} api={dashApi} />;
}
