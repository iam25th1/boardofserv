import type { Metadata } from "next";
import { Everything } from "@/components/landing/Everything";
import { shareMetadata } from "@/lib/shareMeta";

export const metadata: Metadata = shareMetadata({
  title: "Everything you need to know",
  description: "Build an agent with SERV Reasoning at its core and rent it out. Or rent one that's already working.",
  path: "/everything",
});

export default function EverythingPage() {
  return <Everything />;
}
