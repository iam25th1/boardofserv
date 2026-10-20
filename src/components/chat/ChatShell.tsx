"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useApi } from "@/lib/useApi";
import { useOpenServLink } from "@/lib/useOpenServLink";
import type { AccountDTO, ConversationDTO } from "@/lib/types";
import { Button, Dialog, TextInput, useToast } from "@/components/ui";
import { AgentsPill, type AgentsPillHandle } from "./AgentsPill";
import { AccountMenu } from "./AccountMenu";
import { MessageList, type StreamingView } from "./MessageList";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { TopBar } from "./TopBar";
import { SketchDock } from "./SketchDock";
import type { AgentSketch } from "@/lib/agentSketch";
import type { MessageView } from "./Message";
import styles from "./ChatShell.module.css";

export function ChatShell() {
  const api = useApi();
  const link = useOpenServLink();
  const { logout } = usePrivy();
  const toast = useToast();

  const [conversations, setConversations] = useState<ConversationDTO[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [streaming, setStreaming] = useState<StreamingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountDTO | null>(null);
  const [linking, setLinking] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [sketch, setSketch] = useState<AgentSketch | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const stopRef = useRef<(() => void) | null>(null);
  // Deltas are gathered and applied once per animation frame, so a fast
  // stream renders (and dusts in) in a few batches, not a word at a time.
  const pendingRef = useRef("");
  const frameRef = useRef<number | null>(null);
  const agentsRef = useRef<AgentsPillHandle>(null);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await api.listConversations());
    } catch {
      // list stays as it was; a transient error should not blank the agents list
    }
  }, [api]);

  const refreshAccount = useCallback(async () => {
    try {
      setAccount(await api.getAccount());
    } catch {
      setAccount(null);
    }
  }, [api]);

  useEffect(() => {
    void refreshConversations();
    void refreshAccount();
  }, [refreshConversations, refreshAccount]);

  // No conversation produces an agent sketch yet (that is the next brief).
  // In development, ?sketch=demo (or ready) shows the dock with the mockup's
  // ETH watcher. The import sits inside a development-only branch, so the
  // fixture is not in a production build at all. The switch only flips this
  // local state.
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      const mode = new URLSearchParams(window.location.search).get("sketch");
      if (mode === "demo" || mode === "ready") {
        void import("@/lib/agentSketch.fixture").then((f) => setSketch(mode === "ready" ? f.ethWatcherReady : f.ethWatcher));
      }
    }
  }, []);

  const openConversation = useCallback(
    async (id: string) => {
      setActiveId(id);
      setError(null);
      setStreaming(null);
      try {
        const rows = await api.getMessages(id);
        setMessages(rows.map((m) => ({ id: m.id, role: m.role, content: m.content, source: m.source, sourceLabel: m.sourceLabel })));
      } catch {
        setMessages([]);
      }
    },
    [api],
  );

  const startNew = useCallback(() => {
    setActiveId(null);
    setMessages([]);
    setStreaming(null);
    setError(null);
    setTimeout(() => (document.querySelector("[data-composer-input]") as HTMLTextAreaElement | null)?.focus(), 30);
  }, []);

  const dropPending = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    const text = pendingRef.current;
    pendingRef.current = "";
    return text;
  }, []);

  const run = useCallback(
    (body: { conversationId?: string; content?: string; regenerate?: boolean; editMessageId?: string }) => {
      setBusy(true);
      setError(null);
      dropPending();
      // The reply being built lives in a local and is copied into state, so
      // finishing it never relies on a side effect inside a state updater
      // (strict mode runs those twice).
      let live: StreamingView = { key: crypto.randomUUID(), content: "" };
      setStreaming(live);
      let convoId = body.conversationId ?? activeId ?? undefined;
      stopRef.current = api.sendChat({ ...body, conversationId: convoId }, (e) => {
        if (e.type === "meta") {
          convoId = e.conversationId;
          if (!activeId) setActiveId(e.conversationId);
          live = { ...live, source: e.source, sourceLabel: e.label };
          setStreaming(live);
        } else if (e.type === "delta") {
          pendingRef.current += e.text;
          if (frameRef.current === null) {
            frameRef.current = requestAnimationFrame(() => {
              const text = dropPending();
              if (!text) return;
              live = { ...live, content: live.content + text };
              setStreaming(live);
            });
          }
        } else if (e.type === "done") {
          const content = live.content + dropPending();
          if (content.trim()) {
            const settled: MessageView = {
              id: e.messageId ?? crypto.randomUUID(),
              clientKey: live.key,
              settled: true,
              role: "assistant",
              content,
              source: e.source,
              sourceLabel: e.label,
            };
            setMessages((prev) => [...prev, settled]);
          }
          setStreaming(null);
          setBusy(false);
          stopRef.current = null;
          void refreshConversations();
          void refreshAccount();
        } else if (e.type === "error") {
          dropPending();
          setStreaming(null);
          setBusy(false);
          stopRef.current = null;
          setError(e.message);
        }
      });
    },
    [api, activeId, refreshConversations, refreshAccount, dropPending],
  );

  const send = useCallback(
    (text: string) => {
      const optimistic: MessageView = { id: crypto.randomUUID(), role: "user", content: text };
      setMessages((prev) => [...prev, optimistic]);
      run({ conversationId: activeId ?? undefined, content: text });
    },
    [activeId, run],
  );

  const stop = useCallback(async () => {
    stopRef.current?.();
    stopRef.current = null;
    dropPending();
    setBusy(false);
    setStreaming(null);
    if (activeId) await openConversation(activeId);
  }, [activeId, openConversation, dropPending]);

  const regenerate = useCallback(() => {
    if (!activeId) return;
    setMessages((prev) => {
      const idx = [...prev].reverse().findIndex((m) => m.role === "assistant");
      if (idx === -1) return prev;
      return prev.slice(0, prev.length - 1 - idx);
    });
    run({ conversationId: activeId, regenerate: true });
  }, [activeId, run]);

  const edit = useCallback(
    (id: string, content: string) => {
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === id);
        if (i === -1) return prev;
        return [...prev.slice(0, i), { ...prev[i]!, content }];
      });
      run({ conversationId: activeId ?? undefined, editMessageId: id, content });
    },
    [activeId, run],
  );

  const retry = useCallback(() => {
    if (activeId) run({ conversationId: activeId, regenerate: true });
  }, [activeId, run]);

  const doLink = useCallback(async () => {
    setLinking(true);
    try {
      await link();
      await refreshAccount();
      toast.show({ title: "OpenServ account linked" });
    } catch {
      toast.show({ title: "Could not link OpenServ. Try again.", tone: "danger" });
    } finally {
      setLinking(false);
    }
  }, [link, refreshAccount, toast]);

  const doRename = useCallback(async () => {
    if (!renameId || !renameValue.trim()) return;
    await api.renameConversation(renameId, renameValue.trim());
    setRenameId(null);
    void refreshConversations();
  }, [api, renameId, renameValue, refreshConversations]);

  const doDelete = useCallback(async () => {
    if (!deleteId) return;
    await api.deleteConversation(deleteId);
    if (deleteId === activeId) startNew();
    setDeleteId(null);
    void refreshConversations();
  }, [api, deleteId, activeId, startNew, refreshConversations]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        startNew();
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        agentsRef.current?.openSearch();
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        (document.querySelector("[data-composer-input]") as HTMLTextAreaElement | null)?.focus();
      } else if (e.key === "?" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) {
        e.preventDefault();
        setShortcuts(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startNew]);

  const notReady = account !== null && !account.linked;

  return (
    <div className={styles.app}>
      <TopBar
        agents={
          <AgentsPill
            ref={agentsRef}
            conversations={conversations}
            activeId={activeId}
            replyingId={busy ? activeId : null}
            onNew={startNew}
            onSelect={openConversation}
            onRename={(id) => {
              setRenameId(id);
              setRenameValue(conversations.find((c) => c.id === id)?.title ?? "");
            }}
            onDelete={(id) => setDeleteId(id)}
          />
        }
        account={
          <AccountMenu
            account={account}
            linking={linking}
            onLink={doLink}
            onSignOut={() => void logout()}
            onOpenShortcuts={() => setShortcuts(true)}
          />
        }
      />

      {messages.length === 0 && !streaming ? (
        <EmptyState onPick={send} disabled={busy || notReady} />
      ) : (
        <MessageList
          messages={messages}
          streaming={streaming}
          error={error}
          busy={busy}
          onRetry={retry}
          onRegenerate={regenerate}
          onEdit={edit}
        />
      )}

      <Composer
        conversationKey={activeId ?? "new"}
        busy={busy}
        disabled={notReady}
        onSend={send}
        onStop={stop}
        dock={sketch && <SketchDock sketch={sketch} onToggle={(live) => setSketch({ ...sketch, live })} />}
      />
      {notReady && (
        <div className={styles.linkBanner} role="status">
          <span>Link your OpenServ account to get replies from SERV.</span>
          <Button size="sm" onClick={doLink} disabled={linking}>
            {linking ? "Linking..." : "Link now"}
          </Button>
        </div>
      )}

      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />

      <Dialog
        open={renameId !== null}
        onClose={() => setRenameId(null)}
        title="Rename conversation"
        actions={
          <>
            <Button variant="ghost" onClick={() => setRenameId(null)}>
              Cancel
            </Button>
            <Button onClick={doRename} disabled={!renameValue.trim()}>
              Save
            </Button>
          </>
        }
      >
        <TextInput value={renameValue} onChange={(e) => setRenameValue(e.target.value)} aria-label="Conversation title" autoFocus />
      </Dialog>

      <Dialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        title="Delete this conversation?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={doDelete}>
              Delete
            </Button>
          </>
        }
      >
        <p className={styles.confirmText}>This removes the conversation and its messages. It cannot be undone.</p>
      </Dialog>
    </div>
  );
}
