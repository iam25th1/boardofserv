"use client";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { SkeletonPanel } from "@/components/ui";
import { Page } from "@/components/shell/Page";
import { AgentPageView, type AgentPageApi } from "@/components/market/AgentPageView";
import { RentBox } from "@/components/market/RentBox";
import { fetchAgentPage } from "@/lib/publicApi";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";

// An agent's page on the board, for anyone; renting it needs sign-in.
export default function AgentOnBoard({ params }: { params: { id: string } }) {
  if (!privyAppId()) return <Public id={params.id} />;
  return <WithSignIn id={params.id} />;
}

function Public({ id }: { id: string }) {
  const api: AgentPageApi = useMemo(() => ({ load: (agentId) => fetchAgentPage(agentId) }), []);
  return <AgentPageView id={id} api={api} />;
}

function WithSignIn({ id }: { id: string }) {
  const { ready, authenticated } = usePrivy();
  const signedIn = ready && authenticated;
  const api = useApi();
  const router = useRouter();
  const here = `/app/board/agents/${id}`;
  const pageApi = useMemo<AgentPageApi>(
    () => ({
      load: (agentId) => (signedIn ? api.getAgentPage(agentId) : fetchAgentPage(agentId)),
      rent: (page) => <RentBox page={page} signedIn={signedIn} here={here} rent={() => api.rentAgent(page.id)} onRented={(r) => router.push(`/app/rentals/${r.id}/setup`)} />,
      ...(signedIn ? { report: api.report } : { signIn: `/login?next=${encodeURIComponent(here)}` }),
    }),
    [api, signedIn, here, router],
  );
  if (!ready) {
    return (
      <Page width="wide">
        <SkeletonPanel label="Getting the agent" lines={8} />
      </Page>
    );
  }
  return <AgentPageView id={id} api={pageApi} />;
}
