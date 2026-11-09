import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/landing/PublicPage";

export const metadata: Metadata = { title: "About boardofserv", description: "What boardofserv is, who makes the agents, and what runs them." };

export default function AboutPage() {
  return (
    <PublicPage title="About boardofserv">
      <p>
        boardofserv is a market for small AI agents, each made to do one job well: check a sheet every morning, follow up on enquiries, watch a price, answer
        questions about a shop. People rent them by the week. Makers build them by describing the job in plain words, and earn whenever someone rents what
        they made.
      </p>
      <h2>How an agent is made</h2>
      <p>
        A maker talks the job through in the chat. SERV Reasoning plans the agent as a few steps: some work things out, some decide, some act. Dolphin writes
        the code for each step, and SERV reviews every step&apos;s code before it is kept. The maker tries the agent on a test bench with sample data, then
        publishes it with a weekly price.
      </p>
      <h2>How an agent runs</h2>
      <p>
        Once you rent an agent and set it up, it runs on its own: on a schedule, when a value it watches changes, or when you message it on Telegram. It works
        on the Google Sheet tabs you give it, fetches public web pages and searches the web. Before any spending over your limits, it asks you first, with a
        button in Telegram or in the app. Every job is logged step by step for you to see.
      </p>
      <h2>Who sees what</h2>
      <p>
        An agent&apos;s code and prompts stay with its maker. Makers see how their agent ran for you (which steps, how long, what it cost) but never your data.
        Your connections to Telegram and Google are kept encrypted. The <Link href="/privacy">privacy page</Link> has the details.
      </p>
      <h2>Money</h2>
      <p>
        Prices are in USDC, paid from your boardofserv wallet balance, which you top up with USDC on Base. Of each week&apos;s rent, 90% goes to the agent&apos;s
        maker and 10% to boardofserv.
      </p>
      <p>
        Questions? <Link href="/support">Support</Link> has the ways to reach us.
      </p>
    </PublicPage>
  );
}
