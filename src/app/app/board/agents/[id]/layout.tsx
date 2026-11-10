import type { Metadata } from "next";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { agentPage } from "@/lib/market/listings";
import { shareMetadata } from "@/lib/shareMeta";

// An agent's page on the board, as a shared link shows it: its name and
// what it does, with the beta's card. An agent that isn't on the board (or
// a database that can't answer) gets the board's own words.

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const path = `/app/board/agents/${params.id}`;
  const fallback = shareMetadata({ title: "An agent on boardofserv", description: "A small agent that does one job, on the boardofserv board. A beta, on test USDC.", path });
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return fallback;
  try {
    const page = await agentPage(serverRuntime(), params.id);
    if (!page) return fallback;
    const does = page.does.length > 180 ? `${page.does.slice(0, 177).trimEnd()}...` : page.does;
    return shareMetadata({ title: `${page.name} on boardofserv`, description: `${does} A beta, on test USDC.`, path });
  } catch {
    return fallback;
  }
}

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return children;
}
