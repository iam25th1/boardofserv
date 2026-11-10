import type { Metadata } from "next";
import { Everything } from "@/components/landing/Everything";
import { shareMetadata } from "@/lib/shareMeta";

export const metadata: Metadata = shareMetadata({
  title: "Everything you need to know",
  description: "boardofserv is a market for AI agents that actually work: what it is, how renting and building one works, and what's under the hood.",
  path: "/everything",
});

export default function EverythingPage() {
  return <Everything />;
}
