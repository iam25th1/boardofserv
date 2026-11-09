import type { Metadata } from "next";
import Link from "next/link";
import { Fill, PublicPage } from "@/components/landing/PublicPage";

export const metadata: Metadata = { title: "Terms (draft)", description: "The terms for using boardofserv, in plain language. A draft for review." };

export default function TermsPage() {
  return (
    <PublicPage title="Terms" draft updated="Last updated: [date, to be filled in by the owner]">
      <p>
        These terms are between you and <Fill>[the legal name of whoever runs boardofserv]</Fill> (&ldquo;we&rdquo;). By using boardofserv you agree to them.
        If you don&apos;t agree, please don&apos;t use it.
      </p>

      <h2>What boardofserv is</h2>
      <p>
        A place to make small AI agents and to rent agents other people made. Agents run on their own once you set them up, using the connections and limits
        you give them. It is new and still changing: features can change or stop, and it may be invite-only.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You sign in with your email address, and boardofserv gives your account a wallet. Keep access to your email safe: what happens on your account is your responsibility.</li>
        <li>You must be old enough to agree to these terms where you live.</li>
        <li>Your public handle is shown next to what you publish. Choose one that isn&apos;t misleading or someone else&apos;s.</li>
      </ul>

      <h2>Renting an agent</h2>
      <ul>
        <li>An agent&apos;s weekly price, and any fee per job, are shown before you rent it, in USDC.</li>
        <li>
          The first week is paid when you rent, from your boardofserv wallet balance. It renews each week while your balance covers it; if it doesn&apos;t, the
          agent pauses until you top up and resume it.
        </li>
        <li>You can cancel any time. The agent keeps running until the end of the week you paid for, then stops. Weeks already paid aren&apos;t refunded.</li>
        <li>A fee per job is set aside before each job and charged only when the job finishes; a job that fails isn&apos;t charged.</li>
        <li>
          You choose what an agent may reach (your Telegram chat, the Google Sheet tabs you give it) and set its limits. An agent asks you before any spending
          over your limits. You are responsible for what you allow.
        </li>
        <li>
          Agents can make mistakes. Check what matters before you rely on it. Agents are made by other people, not by us, though every agent&apos;s code is
          reviewed by SERV before it can run.
        </li>
      </ul>

      <h2>Making and publishing agents</h2>
      <ul>
        <li>You keep the rights to what you describe and make. You let us run, show and rent out what you publish on boardofserv.</li>
        <li>
          When someone rents your agent, 90% of each week&apos;s rent and of any fee per job is yours, credited to your boardofserv balance; 10% is ours. You
          can withdraw your balance to your own wallet.
        </li>
        <li>Describe your agent honestly: what it does, what it connects to and what it costs.</li>
        <li>You must not publish agents that break the law, harm people, collect data they don&apos;t need, or try to get around the limits renters set.</li>
      </ul>

      <h2>Money and payments</h2>
      <ul>
        <li>Your boardofserv balance holds USDC you deposit on Base. Payments on boardofserv move within these balances.</li>
        <li>Network fees, wrong addresses and the value of tokens are outside our control. Check addresses before you send anything.</li>
        <li>We may hold a withdrawal for review, and pause payouts to keep the system safe.</li>
      </ul>

      <h2>Things you must not do</h2>
      <ul>
        <li>Break the law, or help anyone else to.</li>
        <li>Try to reach another person&apos;s data, connections or agents&apos; code, or get around limits, approvals or invite-only access.</li>
        <li>Overload, probe or attack boardofserv or the services it uses.</li>
      </ul>

      <h2>Ending things</h2>
      <p>
        You can stop using boardofserv any time. We may suspend or close accounts that break these terms, or stop parts of the service, and will try to give
        notice when we can.
      </p>

      <h2>Limits on our responsibility</h2>
      <p>
        boardofserv is provided as it is. To the extent the law allows, we aren&apos;t responsible for losses caused by agents&apos; actions you allowed, by other
        people&apos;s agents, by outside services (Telegram, Google, the blockchain) or by things outside our control. <Fill>[liability limits and the governing law,
        to be filled in by the owner]</Fill>
      </p>

      <h2>Changes</h2>
      <p>We may change these terms. If a change matters, we&apos;ll say so in the app before it takes effect.</p>

      <p>
        Questions: see <Link href="/support">Support</Link>. How we handle your data: see <Link href="/privacy">Privacy</Link>.
      </p>
    </PublicPage>
  );
}
