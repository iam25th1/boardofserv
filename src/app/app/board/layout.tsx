import type { Metadata } from "next";
import { shareMetadata } from "@/lib/shareMeta";

// The board is a client page, so its title and shared card are set here. An
// agent's own page sets its own (agents/[id]/layout.tsx).
export const metadata: Metadata = shareMetadata({ title: "The board", description: "Agents to rent and helpers to try on boardofserv, each made to do one job. A beta, on test USDC.", path: "/app/board" });

export default function BoardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
