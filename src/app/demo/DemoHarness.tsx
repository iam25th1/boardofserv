"use client";
import { useEffect, useState } from "react";
import type { AccountDTO, ConversationDTO } from "@/lib/types";
import type { MessageView } from "@/components/chat/Message";
import { AgentsPill } from "@/components/chat/AgentsPill";
import { AccountMenu } from "@/components/chat/AccountMenu";
import { MessageList } from "@/components/chat/MessageList";
import { Composer } from "@/components/chat/Composer";
import { EmptyState } from "@/components/chat/EmptyState";
import { TopBar } from "@/components/chat/TopBar";
import { Chips } from "@/components/chat/Chips";
import { SketchDock } from "@/components/chat/SketchDock";
import { sketchFromDTO, type AgentSketch } from "@/lib/agentSketch";
import type { StreamingView } from "@/components/chat/MessageList";
import shell from "@/components/chat/ChatShell.module.css";

const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();

const CONVERSATIONS: ConversationDTO[] = [
  { id: "1", title: "Tell my Telegram group when ETH drops 5 percent", sketchName: "ETH floor watch", publishedSlug: null, createdAt: iso(0), updatedAt: iso(0) },
  { id: "2", title: "Daily Gmail summary at 8am", sketchName: "Morning inbox digest", publishedSlug: null, createdAt: iso(0), updatedAt: iso(0) },
  { id: "5", title: "Write blurbs for my shop", sketchName: "Shop blurb writer", publishedSlug: "shop-blurb-writer", createdAt: iso(1), updatedAt: iso(1) },
  { id: "3", title: "Post new blog articles to X", sketchName: "Blog to X", publishedSlug: null, createdAt: iso(3), updatedAt: iso(3) },
  { id: "4", title: "Watch a wallet for large transfers", sketchName: null, publishedSlug: null, createdAt: iso(12), updatedAt: iso(12) },
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
  { id: "a1", role: "assistant", content: ASSISTANT, source: "serv", sourceLabel: "SERV Reasoning" },
];
// backup=1 shows the same reply as if the backup model had answered it.
const BACKUP_REPLY: MessageView = { ...MESSAGES[1]!, source: "fallback", sourceLabel: "GPT-4o mini" };

// The account menu's handle check, without a server: "maya" is taken.
const demoCheckHandle = async (handle: string) => (handle === "maya" ? { available: false, error: "That handle is taken." } : { available: true });

// state=replay plays the seeded reply through the real streaming path: the
// thinking scribble first, then chunks of a few words at network-like pace
// (repeat=8 makes it long), so the word dust-in can be watched in development.
function useReplay(on: boolean, repeat: number): StreamingView | null {
  const [view, setView] = useState<StreamingView | null>(null);
  useEffect(() => {
    if (!on) return;
    const words = Array.from({ length: repeat }, () => ASSISTANT).join("\n\n").match(/\S+\s*/g) ?? [];
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    setView({ key: "replay", content: "", source: "serv", sourceLabel: "SERV Reasoning" });
    const tick = () => {
      const n = 1 + Math.floor(Math.random() * 6);
      const chunk = words.slice(i, i + n).join("");
      i += n;
      setView((v) => (v ? { ...v, content: v.content + chunk } : v));
      if (i < words.length) timer = setTimeout(tick, 25 + Math.random() * 40);
    };
    timer = setTimeout(tick, 2600);
    return () => clearTimeout(timer);
  }, [on, repeat]);
  return view;
}

export function DemoHarness({
  state,
  balance,
  menuOpen,
  agentsOpen,
  chips,
  repeat = 1,
  sketchMode,
  backup,
  sketching,
}: {
  state: string;
  balance: "ok" | "low";
  menuOpen?: boolean;
  agentsOpen?: boolean;
  chips?: boolean;
  repeat?: number;
  sketchMode?: string;
  backup?: boolean;
  sketching?: boolean;
}) {
  // Dev harness only: render after mount so the seeded, time-based data never
  // causes a server and client hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const replay = useReplay(state === "replay", repeat);
  const [sketch, setSketch] = useState<AgentSketch | null>(null);
  useEffect(() => {
    if (process.env.NODE_ENV === "development" && (sketchMode === "demo" || sketchMode === "ready")) {
      void import("@/lib/agentSketch.fixture").then((f) => setSketch(sketchMode === "ready" ? f.ethWatcherReady : f.ethWatcher));
    }
    // sketch=live: the dock on stored data, exactly as a real conversation
    // shows it (no switch to flip, no cost). sketch=live-ready has every field.
    if (process.env.NODE_ENV === "development" && (sketchMode === "live" || sketchMode === "live-ready")) {
      void import("@/lib/agentSketch.fixture").then((f) =>
        setSketch(sketchFromDTO(sketchMode === "live-ready" ? { ...f.ethWatcherStored, tells: "Telegram", asking: null } : f.ethWatcherStored)),
      );
    }
    // sketch=answer: an answer helper waiting on what it gives back;
    // sketch=answer-ready has every field.
    if (process.env.NODE_ENV === "development" && (sketchMode === "answer" || sketchMode === "answer-ready")) {
      void import("@/lib/agentSketch.fixture").then((f) =>
        setSketch(
          sketchFromDTO(sketchMode === "answer-ready" ? { ...f.blurbHelperStored, gives: "The blurb, ready to paste", asking: null } : f.blurbHelperStored),
        ),
      );
    }
  }, [sketchMode]);
  if (!mounted) return null;
  const account: AccountDTO = {
    email: "maya@example.com",
    handle: "maker_4821",
    handleChosen: false,
    walletAddress: "0x5f88...3148",
    openservUserId: "134829",
    linked: true,
    balance,
  };

  const partial = "Here is what your agent would do.\n\n## A watcher for ETH\n\n1. Check the ETH price every minute.\n2. Compare it to the price";
  const streaming: StreamingView | null =
    state === "replay"
      ? replay
      : state === "thinking"
        ? { key: "demo-stream", content: "" }
        : state === "streaming"
          ? { key: "demo-stream", content: partial, source: "serv", sourceLabel: "SERV Reasoning" }
          : null;
  const messages = ["streaming", "thinking", "replay"].includes(state) ? [MESSAGES[0]!] : backup ? [MESSAGES[0]!, BACKUP_REPLY] : MESSAGES;
  const error = state === "error" ? "The reply could not be completed. You can retry." : null;

  return (
    <div className={shell.app}>
      <TopBar
        agents={
          <AgentsPill
            conversations={CONVERSATIONS}
            activeId="1"
            replyingId={streaming ? "1" : null}
            onNew={() => {}}
            onSelect={() => {}}
            onRename={() => {}}
            onDelete={() => {}}
            startOpen={agentsOpen}
          />
        }
        account={
          <AccountMenu
            account={account}
            onSignOut={() => {}}
            onOpenShortcuts={() => {}}
            checkHandle={demoCheckHandle}
            onSaveHandle={async () => {}}
            startOpen={menuOpen}
          />
        }
      />
      {state === "empty" ? (
        <EmptyState onPick={() => {}} />
      ) : (
        <MessageList
          messages={messages}
          streaming={streaming}
          error={error}
          busy={Boolean(streaming)}
          onRetry={() => {}}
          onRegenerate={() => {}}
          onEdit={() => {}}
          footer={chips ? <Chips options={["Telegram", "Email"]} onPick={() => {}} /> : undefined}
        />
      )}
      <Composer
        conversationKey="demo"
        busy={Boolean(streaming)}
        onSend={() => {}}
        onStop={() => {}}
        dock={
          sketch && (
            <SketchDock
              sketch={sketch}
              canSwitch={sketchMode === "demo" || sketchMode === "ready"}
              sketching={sketching}
              onToggle={(live) => setSketch({ ...sketch, live })}
            />
          )
        }
      />
    </div>
  );
}
