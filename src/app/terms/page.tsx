import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/landing/PublicPage";

export const metadata: Metadata = { title: "Using the beta", description: "A few plain notes on using the boardofserv beta." };

export default function UsingTheBetaPage() {
  return (
    <PublicPage title="Using the beta">
      <p>A few plain notes while boardofserv is a beta.</p>
      <ul>
        <li>It&apos;s a demo. Don&apos;t rely on it for anything important.</li>
        <li>Agents can make mistakes. Check what matters before you act on it.</li>
        <li>Payments use test USDC on Base Sepolia. Test funds have no value and can&apos;t be turned into real money.</li>
        <li>Accounts and data may be reset while things change.</li>
        <li>Be decent to other people on it: no spam, no scams, nothing meant to hurt anyone.</li>
      </ul>
      <p>
        Something wrong, or a question? Tell us through <Link href="/support">Support</Link>. What we keep about you is on{" "}
        <Link href="/privacy">Your data</Link>.
      </p>
    </PublicPage>
  );
}
