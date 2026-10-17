"use client";
import { useEffect, useState } from "react";
import type { AccountDTO, ConversationDTO } from "@/lib/types";
import type { MessageView } from "@/components/chat/Message";
import { Sidebar } from "@/components/chat/Sidebar";
import { AccountMenu } from "@/components/chat/AccountMenu";
import { MessageList } from "@/components/chat/MessageList";
import { Composer } from "@/components/chat/Composer";
import { EmptyState } from "@/components/chat/EmptyState";
import { Wordmark } from "@/components/chat/Wordmark";
import { IconButton } from "@/components/ui";
import { MenuIcon, PlusIcon } from "@/components/icons";
import shell from "@/components/chat/ChatShell.module.css";

const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();

const CONVERSATIONS: ConversationDTO[] = [
  { id: "1", title: "Tell my Telegram group when ETH drops 5 percent", createdAt: iso(0), updatedAt: iso(0) },
  { id: "2", title: "Daily Gmail summary at 8am", createdAt: iso(0), updatedAt: iso(0) },
  { id: "3", title: "Post new blog articles to X", createdAt: iso(3), updatedAt: iso(3) },
  { id: "4", title: "Watch a wallet for large transfers", createdAt: iso(12), updatedAt: iso(12) },
];

const ASSISTANT = `Here is what your agent would do.

## A watcher for ETH

1. Check the ETH price every minute.
2. Compare it to the price 24 hours ago.
3. When it falls 5 percent or more, post a message to your Telegram group.

| Field | Example |
| --- | --- |
| Pair | ETH / USD |
| Drop | 5 percent |
| Window | 24 hours |

The threshold is \`0.95\` of the earlier price, and you can tune it any time. See the [OpenServ docs](https://docs.openserv.ai) for what connects later.

\`\`\`js
// rough logic, for illustration
if (priceNow <= price24hAgo * 0.95) {
  sendTelegram("ETH is down 5 percent in the last 24 hours");
}
\`\`\`

Want it to post when ETH recovers too, or only on the way down?`;

const MESSAGES: MessageView[] = [
  { id: "u1", role: "user", content: "Tell my Telegram group when ETH drops 5 percent" },
  { id: "a1", role: "assistant", content: ASSISTANT, source: "serv", sourceLabel: "SERV" },
];

export function DemoHarness({ state, balance, menuOpen, drawerOpen }: { state: string; balance: "ok" | "low"; menuOpen?: boolean; drawerOpen?: boolean }) {
  const [drawer, setDrawer] = useState(Boolean(drawerOpen));
  // Dev harness only: render after mount so the seeded, time-based data never
  // causes a server and client hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  const account: AccountDTO = {
    email: "maya@example.com",
    walletAddress: "0x5f88...3148",
    openservUserId: "134829",
    linked: true,
    balance,
  };

  const streaming =
    state === "streaming"
      ? { content: "Here is what your agent would do.\n\n## A watcher for ETH\n\n1. Check the ETH price every minute.\n2. Compare it to the price", source: "serv", sourceLabel: "SERV" }
      : null;
  const messages = state === "streaming" ? [MESSAGES[0]!] : MESSAGES;
  const error = state === "error" ? "The reply could not be completed. You can retry." : null;

  const accountMenu = <AccountMenu account={account} linking={false} onLink={() => {}} onSignOut={() => {}} startOpen={menuOpen} />;
  const sidebar = (
    <Sidebar
      conversations={CONVERSATIONS}
      activeId="1"
      query=""
      onQuery={() => {}}
      onNew={() => {}}
      onSelect={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onOpenShortcuts={() => {}}
      footer={accountMenu}
    />
  );

  return (
    <div className={shell.app}>
      <aside className={shell.railDesktop}>{sidebar}</aside>
      {drawer && (
        <div className={shell.scrim} onMouseDown={() => setDrawer(false)}>
          <div className={shell.drawer} onMouseDown={(e) => e.stopPropagation()}>
            {sidebar}
          </div>
        </div>
      )}
      <main className={shell.main}>
        <header className={shell.topbar}>
          <IconButton label="Open conversations" variant="quiet" onClick={() => setDrawer(true)}>
            <MenuIcon />
          </IconButton>
          <div className={shell.topbarMark}>
            <Wordmark />
          </div>
          <IconButton label="New conversation" variant="quiet" onClick={() => {}}>
            <PlusIcon />
          </IconButton>
        </header>
        {state === "empty" ? (
          <EmptyState onPick={() => {}} />
        ) : (
          <MessageList messages={messages} streaming={streaming} error={error} busy={Boolean(streaming)} onRetry={() => {}} onRegenerate={() => {}} onEdit={() => {}} />
        )}
        <Composer conversationKey="demo" busy={Boolean(streaming)} onSend={() => {}} onStop={() => {}} />
      </main>
    </div>
  );
}
