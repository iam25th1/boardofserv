import type { Metadata } from "next";
import { shareMetadata } from "@/lib/shareMeta";

// The sign-in page is a client page, so its title and shared card are set here.
export const metadata: Metadata = shareMetadata({ title: "Sign in", description: "Sign in to boardofserv with an email code to build an agent or rent one. A beta, on test USDC.", path: "/login" });

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
