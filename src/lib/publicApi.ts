import type { AgentListingDTO, AgentPageDTO, PaymentsDTO, PublicHelperDTO } from "./types";

// Calls that need no sign-in: the board and a helper's public page.

export interface BoardQuery {
  q?: string;
  kind?: "all" | "helpers" | "agents";
  connects?: AgentListingDTO["connects"];
  // Weekly price bounds, in whole USDC as typed.
  min?: string;
  max?: string;
}

export async function fetchBoard(query: BoardQuery | string, signal?: AbortSignal): Promise<{ helpers: PublicHelperDTO[]; agents: AgentListingDTO[] }> {
  const b = typeof query === "string" ? { q: query } : query;
  const p = new URLSearchParams();
  if (b.q?.trim()) p.set("q", b.q.trim());
  if (b.kind && b.kind !== "all") p.set("kind", b.kind);
  if (b.connects?.length) p.set("connects", b.connects.join(","));
  if (b.min?.trim()) p.set("min", b.min.trim());
  if (b.max?.trim()) p.set("max", b.max.trim());
  const qs = p.toString();
  const res = await fetch(`/api/board${qs ? `?${qs}` : ""}`, { signal });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const data = (await res.json()) as { helpers: PublicHelperDTO[]; agents?: AgentListingDTO[] };
  return { helpers: data.helpers, agents: data.agents ?? [] };
}

export async function fetchAgentPage(id: string, signal?: AbortSignal): Promise<AgentPageDTO | null> {
  const res = await fetch(`/api/market/agents/${encodeURIComponent(id)}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return ((await res.json()) as { agent: AgentPageDTO }).agent;
}

export type HelperPage = { helper: PublicHelperDTO } | { takenDown: string } | { missing: true };

export async function fetchHelper(slug: string, signal?: AbortSignal): Promise<HelperPage> {
  const res = await fetch(`/api/helpers/${encodeURIComponent(slug)}`, { signal });
  if (res.status === 404) return { missing: true };
  if (res.status === 410) return { takenDown: ((await res.json()) as { name: string }).name };
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as { helper: PublicHelperDTO };
}

// Whether payments are on, and the currencies they take.
export async function fetchPayments(signal?: AbortSignal): Promise<PaymentsDTO> {
  const res = await fetch("/api/payments", { signal });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return ((await res.json()) as { payments: PaymentsDTO }).payments;
}
