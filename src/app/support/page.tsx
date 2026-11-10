import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/landing/PublicPage";
import { shareMetadata } from "@/lib/shareMeta";
import { supportEmail } from "@/lib/support";

export const metadata: Metadata = shareMetadata({ title: "Support", description: "How to reach boardofserv for help, or to have your data deleted.", path: "/support" });

export default function SupportPage() {
  const email = supportEmail();
  return (
    <PublicPage title="Support">
      <p>Stuck, something broke, or you want your data deleted? Here&apos;s how to reach us.</p>
      <h2>On Telegram</h2>
      <p>
        Message <a href="https://t.me/boardofservbot">@boardofservbot</a> with <strong>/support</strong> and then what happened, in the same message: which
        agent, and roughly when. It reaches the people who run boardofserv, whether or not your chat is linked. (Other messages to the bot go to your
        agents.)
      </p>
      <h2>By email</h2>
      {email ? (
        <p>
          Write to <a href={`mailto:${email}`}>{email}</a>.
        </p>
      ) : (
        <p>There&apos;s no email address yet. Telegram is the way for now.</p>
      )}
      <h2>Before you write</h2>
      <ul>
        <li>
          A job that failed says why on its page: open it from <Link href="/app/installations">Your agents</Link>.
        </li>
        <li>An agent that paused says why too, and what to do (connect Telegram or Google again, or top up).</li>
        <li>
          Questions waiting for your answer are under <Link href="/app/approvals">Waiting for you</Link>.
        </li>
      </ul>
      <p>Never send anyone your keys, your wallet&apos;s recovery words or a code from your email: boardofserv never asks for them.</p>
    </PublicPage>
  );
}
