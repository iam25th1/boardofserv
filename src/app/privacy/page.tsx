import type { Metadata } from "next";
import Link from "next/link";
import { Fill, PublicPage } from "@/components/landing/PublicPage";

export const metadata: Metadata = { title: "Privacy (draft)", description: "What boardofserv keeps, why, and who sees it. A draft for review." };

export default function PrivacyPage() {
  return (
    <PublicPage title="Privacy" draft updated="Last updated: [date, to be filled in by the owner]">
      <p>This is what boardofserv keeps about you, why, who else sees it, and what you can do about it.</p>

      <h2>What we keep</h2>
      <ul>
        <li>
          <strong>Your account:</strong> your email address from sign-in, the wallet address made for your account, your public handle, and whether you&apos;re
          let in while it is invite-only.
        </li>
        <li>
          <strong>Your chats with the builder</strong>, and the agents and helpers you make.
        </li>
        <li>
          <strong>Your agents&apos; work:</strong> each installation&apos;s settings and rules, what an agent remembers for you, and the log of each job (what each
          step read, made and called), so you can see what happened.
        </li>
        <li>
          <strong>Your connections:</strong> your linked Telegram chat and your Google access, kept encrypted, used only for the calls your agents make for you.
        </li>
        <li>
          <strong>Money:</strong> your balance, deposits, payments, rent and withdrawals, and your linked wallet addresses.
        </li>
        <li>
          <strong>Usage:</strong> how many messages you send and how much model use they cost, to keep within daily limits.
        </li>
      </ul>

      <h2>Who sees it</h2>
      <ul>
        <li>You see all of your own data.</li>
        <li>
          An agent&apos;s maker sees how their agent ran for you (which steps, how long, the model, the cost, whether it worked) but never what it read, made or
          remembered, and never your settings or connections.
        </li>
        <li>Your handle, and what you publish, are public.</li>
        <li>The people who run boardofserv can see account details to keep it working, handle support and approve accounts.</li>
      </ul>

      <h2>Services we use</h2>
      <ul>
        <li>Privy, for sign-in.</li>
        <li>SERV Reasoning and Dolphin, the AI models that build agents, answer the chat and make agents&apos; decisions. What they need goes to them.</li>
        <li>Telegram and Google, only when you connect them, for the messages and sheets you allow.</li>
        <li>Brave Search, for the web searches agents make (the search words, not who you are).</li>
        <li>Cloudflare, which carries the site&apos;s traffic and counts visits.</li>
        <li>Base, the blockchain for deposits and withdrawals: those are public on it.</li>
      </ul>

      <h2>What you can do</h2>
      <ul>
        <li>Disconnect Telegram or Google any time from Connections. Google&apos;s access is revoked when you do.</li>
        <li>Stop an agent, or delete a chat, any time.</li>
        <li>
          Ask for a copy of your data, or for your account to be deleted: see <Link href="/support">Support</Link>. Records of payments are kept as the law
          requires.
        </li>
      </ul>

      <h2>How long we keep it</h2>
      <p>
        <Fill>[retention periods, to be filled in by the owner]</Fill>
      </p>

      <h2>Contact</h2>
      <p>
        <Fill>[the name and contact details of whoever runs boardofserv, for privacy questions]</Fill>
      </p>
    </PublicPage>
  );
}
