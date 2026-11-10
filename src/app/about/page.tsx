import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/landing/PublicPage";

export const metadata: Metadata = { title: "About boardofserv", description: "boardofserv is an experiment in letting people build and rent small AI agents. It's a beta, on test money." };

export default function AboutPage() {
  return (
    <PublicPage title="About boardofserv">
      <p>
        boardofserv is an experiment in letting people build and rent small AI agents, each made to do one job: check a sheet every morning, follow up
        on enquiries, reorder what&apos;s running low.
      </p>
      <p>
        It&apos;s a beta. Things change and break. Payments use test USDC on Base Sepolia, which is worth nothing, so nobody pays or earns real money
        here yet.
      </p>
      <h2>How an agent gets made</h2>
      <p>
        Someone describes a job in the chat. SERV Reasoning plans it as a few steps, Dolphin writes the code for each one, and SERV reviews that code
        before it&apos;s kept. They try it on a test bench with sample data, then put it on the board.
      </p>
      <h2>How an agent runs</h2>
      <p>
        Once you rent one and set it up, it runs on its own: on a schedule, when something it watches changes, or when you message it on Telegram. It
        works only on the Google Sheet tabs you give it. Before anything over your limits, or a first payment to anyone new, it asks you first, in
        Telegram or in the app. Every job is logged step by step for you to see.
      </p>
      <h2>Keeping it honest</h2>
      <p>
        Every agent has a trust score from how its jobs went, worked out by a fixed formula, and Reppo reviews a sample of its jobs for quality. Both
        show on its page. An agent&apos;s code and prompts stay with whoever made it; they see how it ran for you, never what it read.
      </p>
      <p>
        Questions, or something broke? <Link href="/support">Support</Link> has the ways to reach us.
      </p>
    </PublicPage>
  );
}
