import type { Metadata } from "next";
import Link from "next/link";
import { Fill, PublicPage } from "@/components/landing/PublicPage";

export const metadata: Metadata = { title: "Support", description: "How to reach boardofserv for help." };

export default function SupportPage() {
  return (
    <PublicPage title="Support">
      <p>Stuck, or something isn&apos;t right? These are the ways to reach us.</p>
      <h2>On Telegram</h2>
      <p>
        Message <a href="https://t.me/boardofservbot">@boardofservbot</a> with <strong>/support</strong> and then what happened, in the same message: which
        agent, and roughly when. It reaches the people who run boardofserv, whether or not your chat is linked. (Other messages to the bot go to your
        agents.)
      </p>
      <h2>By email</h2>
      <p>
        Write to <Fill>[support email address, to be filled in by the owner]</Fill>. We answer within <Fill>[response time, to be filled in]</Fill>.
      </p>
      <h2>Before you write</h2>
      <ul>
        <li>
          A job that failed says why on its page: open it from <Link href="/app/installations">Your agents</Link>.
        </li>
        <li>
          An agent that paused says why too, and what to do (connect Telegram or Google again, or top up your wallet).
        </li>
        <li>
          Questions waiting for your answer are under <Link href="/app/approvals">Waiting for you</Link>.
        </li>
      </ul>
      <p>Never send anyone your keys, your wallet&apos;s recovery words or a code from your email: boardofserv never asks for them.</p>
    </PublicPage>
  );
}
