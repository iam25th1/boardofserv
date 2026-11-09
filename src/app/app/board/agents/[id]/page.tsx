"use client";
import { useMemo } from "react";
import { AgentPageView, type AgentPageApi } from "@/components/market/AgentPageView";
import { fetchAgentPage } from "@/lib/publicApi";

// An agent's page on the board, for anyone.
export default function AgentOnBoard({ params }: { params: { id: string } }) {
  const api: AgentPageApi = useMemo(() => ({ load: (id) => fetchAgentPage(id) }), []);
  return <AgentPageView id={params.id} api={api} />;
}
