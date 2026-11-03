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
import { Chips } from "./Chips";
import { PublishSheet, type PublishEdits } from "./PublishSheet";
import { PriceFields, draftsOf, readPrices, type PriceDrafts } from "./PriceFields";
import { fetchHelper, fetchPayments } from "@/lib/publicApi";
import { sketchFromDTO, type AgentSketch } from "@/lib/agentSketch";
import type { CurrencyDTO, PublicHelperDTO, SketchDTO } from "@/lib/types";
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
  // The active conversation's stored sketch, updated by each reply.
  const [sketch, setSketch] = useState<SketchDTO | null>(null);
  // Each turn's number, so a turn whose sketch arrives late never overwrites a
  // newer one; and which turn's plan is running, for the dock's note.
  const turnRef = useRef(0);
  const sketchTurnRef = useRef(0);
  const [sketchingTurn, setSketchingTurn] = useState<number | null>(null);
  const activeRef = useRef<string | null>(null);
  // Suggested answers from the latest turn's plan, shown under its reply only,
  // from reply_end. Sending anything clears them; they are not stored.
  const [chips, setChips] = useState<{ messageId: string; options: string[] } | null>(null);
  // Development only: a fixture from ?sketch=demo or ?sketch=ready.
  const [fixture, setFixture] = useState<AgentSketch | null>(null);
  // The helper published from the active conversation, while it is on the
  // board, and the confirm sheet that publishes one.
  const [published, setPublished] = useState<PublicHelperDTO | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [unpublishId, setUnpublishId] = useState<string | null>(null);
  // The currencies payments take (none while they are off), and the price
  // dialog for a helper on the board.
  const [currencies, setCurrencies] = useState<CurrencyDTO[]>([]);
  const [priceSlug, setPriceSlug] = useState<string | null>(null);
  const [priceDrafts, setPriceDrafts] = useState<PriceDrafts>({});
  const [priceBusy, setPriceBusy] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
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
    fetchPayments().then(
      (p) => setCurrencies(p.enabled ? p.currencies : []),
      () => setCurrencies([]),
    );
  }, [refreshConversations, refreshAccount]);

  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  // In development, ?sketch=demo (or ready) shows the dock with the mockup's
  // ETH watcher in place of the conversation's own sketch. The import sits
  // inside a development-only branch, so the fixture is not in a production
  // build at all. Its switch only flips this local state.
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      const mode = new URLSearchParams(window.location.search).get("sketch");
      if (mode === "demo" || mode === "ready") {
        void import("@/lib/agentSketch.fixture").then((f) => setFixture(mode === "ready" ? f.ethWatcherReady : f.ethWatcher));
      }
    }
  }, []);

  const dropPending = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    const text = pendingRef.current;
    pendingRef.current = "";
    return text;
  }, []);

  // Leaving a reply mid-stream (stop, switching conversation, starting a new
  // one) ends it, so its words can never land in another conversation. The
  // server keeps whatever was produced, as it does for stop.
  const abortReply = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    dropPending();
    setBusy(false);
    setStreaming(null);
    setSketchingTurn(null);
  }, [dropPending]);

  const openConversation = useCallback(
    async (id: string) => {
      abortReply();
      setActiveId(id);
      activeRef.current = id;
      setError(null);
      try {
        const { messages: rows, sketch: stored, published: helper } = await api.getConversation(id);
        // Another conversation was opened while this one loaded.
        if (activeRef.current !== id) return;
        setMessages(rows.map((m) => ({ id: m.id, role: m.role, content: m.content, source: m.source, sourceLabel: m.sourceLabel })));
        setSketch(stored);
        setPublished(helper ?? null);
        setChips(null);
      } catch {
        if (activeRef.current !== id) return;
        setMessages([]);
        setSketch(null);
        setPublished(null);
      }
    },
    [api, abortReply],
  );

  const startNew = useCallback(() => {
    abortReply();
    setActiveId(null);
    activeRef.current = null;
    setMessages([]);
    setSketch(null);
    setPublished(null);
    setChips(null);
    setError(null);
    setTimeout(() => (document.querySelector("[data-composer-input]") as HTMLTextAreaElement | null)?.focus(), 30);
  }, [abortReply]);

  const run = useCallback(
    (body: { conversationId?: string; content?: string; regenerate?: boolean; editMessageId?: string }) => {
      const turn = ++turnRef.current;
      setBusy(true);
      setError(null);
      setChips(null);
      dropPending();
      // The reply being built lives in a local and is copied into state, so
      // finishing it never relies on a side effect inside a state updater
      // (strict mode runs those twice).
      let live: StreamingView = { key: crypto.randomUUID(), content: "" };
      setStreaming(live);
      let convoId = body.conversationId ?? activeId ?? undefined;
      let replyId: string | null = null;
      // A new conversation is named by the first event that carries its id.
      const adopt = (id: string) => {
        convoId = id;
        if (!activeId) {
          setActiveId(id);
          activeRef.current = id;
        }
      };

      // The plan runs first, so the dock says "sketching..." until its sketch
      // arrives, or until the reply starts without one (the plan failed).
      let planning = true;
      setSketchingTurn(turn);
      const stopSketching = () => {
        if (!planning) return;
        planning = false;
        setSketchingTurn((t) => (t === turn ? null : t));
      };

      // The reply is finished at reply_end: the words stop, the composer
      // unlocks and the plan's answers show under the reply. Only done is
      // still to come, and it may arrive after the next turn began, so from
      // here on this turn only touches what is still its own.
      const endReply = (messageId: string | undefined, source: string, label: string, choices: string[] = []) => {
        if (replyId !== null) return;
        replyId = messageId ?? live.key;
        const content = live.content + dropPending();
        if (content.trim()) {
          const settled: MessageView = { id: replyId, clientKey: live.key, settled: true, role: "assistant", content, source, sourceLabel: label };
          setMessages((prev) => [...prev, settled]);
          if (choices.length) setChips({ messageId: replyId, options: choices });
        }
        setStreaming(null);
        setBusy(false);
        stopSketching();
      };

      const stopThis = api.sendChat({ ...body, conversationId: convoId }, (e) => {
        if (e.type === "sketch") {
          adopt(e.conversationId);
          stopSketching();
          // Only into the conversation it belongs to, and never over a newer turn's sketch.
          if (convoId !== activeRef.current || turn < sketchTurnRef.current) return;
          sketchTurnRef.current = turn;
          setSketch(e.sketch);
        } else if (e.type === "meta") {
          adopt(e.conversationId);
          live = { ...live, source: e.source, sourceLabel: e.label };
          setStreaming(live);
        } else if (e.type === "delta") {
          stopSketching();
          pendingRef.current += e.text;
          if (frameRef.current === null) {
            frameRef.current = requestAnimationFrame(() => {
              const text = dropPending();
              if (!text) return;
              live = { ...live, content: live.content + text };
              setStreaming(live);
            });
          }
        } else if (e.type === "reply_end") {
          endReply(e.messageId, e.source, e.label, e.choices);
        } else if (e.type === "done") {
          endReply(e.messageId, e.source, e.label);
          if (stopRef.current === stopThis) stopRef.current = null;
          void refreshConversations();
          void refreshAccount();
        } else if (e.type === "error") {
          stopSketching();
          if (replyId !== null) return;
          dropPending();
          setStreaming(null);
          setBusy(false);
          if (stopRef.current === stopThis) stopRef.current = null;
          setError(e.message);
        }
      });
      stopRef.current = stopThis;
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
    abortReply();
    if (activeId) await openConversation(activeId);
  }, [activeId, openConversation, abortReply]);

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
    const renamed = await api.renameConversation(renameId, renameValue.trim());
    // Renaming a sketched conversation renames its agent, dock included.
    if (renameId === activeId && renamed.sketchName) setSketch((s) => s && { ...s, name: renamed.sketchName });
    setRenameId(null);
    void refreshConversations();
  }, [api, renameId, renameValue, activeId, refreshConversations]);

  // Choose a handle: from the account menu, or confirmed in the publish sheet.
  const saveHandle = useCallback(
    async (handle: string) => {
      const saved = await api.setHandle(handle);
      setAccount((a) => a && { ...a, handle: saved.handle, handleChosen: saved.handleChosen });
    },
    [api],
  );

  // Publish the active conversation's answer helper with the sheet's edits,
  // keeping the handle first when the sheet asked for it.
  const doPublish = useCallback(
    async ({ handle, ...edits }: PublishEdits) => {
      const id = activeId;
      if (!id) return;
      setPublishing(true);
      setPublishError(null);
      try {
        if (handle !== undefined) await saveHandle(handle);
        const helper = await api.publishHelper({ conversationId: id, ...edits });
        if (activeRef.current === id) setPublished(helper);
        setSheetOpen(false);
        toast.show({ title: "Published to the board" });
        void refreshConversations();
      } catch (err) {
        setPublishError(err instanceof Error ? err.message : "It could not be published. Try again.");
      } finally {
        setPublishing(false);
      }
    },
    [api, activeId, toast, refreshConversations, saveHandle],
  );

  const doUnpublish = useCallback(async () => {
    const c = conversations.find((x) => x.id === unpublishId);
    setUnpublishId(null);
    if (!c?.publishedSlug) return;
    try {
      await api.unpublishHelper(c.publishedSlug);
      if (c.id === activeRef.current) setPublished(null);
      toast.show({ title: "Taken off the board" });
    } catch {
      toast.show({ title: "Could not take it down. Try again.", tone: "danger" });
    }
    void refreshConversations();
  }, [api, conversations, unpublishId, toast, refreshConversations]);

  // The price dialog starts from the helper's current prices.
  const openPrice = useCallback(
    async (id: string) => {
      const slug = conversations.find((x) => x.id === id)?.publishedSlug;
      if (!slug) return;
      setPriceError(null);
      try {
        const page = await fetchHelper(slug);
        setPriceDrafts("helper" in page ? draftsOf(page.helper.prices) : {});
        setPriceSlug(slug);
      } catch {
        toast.show({ title: "Could not load its price. Try again.", tone: "danger" });
      }
    },
    [conversations, toast],
  );

  const pricing = readPrices(priceDrafts, currencies);
  const doSetPrice = useCallback(async () => {
    if (!priceSlug || pricing.problem) return;
    setPriceBusy(true);
    setPriceError(null);
    try {
      const helper = await api.setPrices(priceSlug, pricing.prices);
      setPublished((p) => (p && p.slug === helper.slug ? helper : p));
      setPriceSlug(null);
      toast.show({ title: helper.prices.length ? "Price saved" : "Free to try again" });
    } catch (err) {
      setPriceError(err instanceof Error ? err.message : "The price could not be saved. Try again.");
    } finally {
      setPriceBusy(false);
    }
  }, [api, priceSlug, pricing, toast]);

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
              const c = conversations.find((x) => x.id === id);
              setRenameValue(c?.sketchName ?? c?.title ?? "");
            }}
            onDelete={(id) => setDeleteId(id)}
            onUnpublish={(id) => setUnpublishId(id)}
            onPrice={currencies.length ? (id) => void openPrice(id) : undefined}
          />
        }
        account={
          <AccountMenu
            account={account}
            linking={linking}
            onLink={doLink}
            onSignOut={() => void logout()}
            onOpenShortcuts={() => setShortcuts(true)}
            checkHandle={api.checkHandle}
            onSaveHandle={saveHandle}
          />
        }
      />

      {messages.length === 0 && !streaming ? (
        <EmptyState onPick={send} disabled={busy} />
      ) : (
        <MessageList
          messages={messages}
          streaming={streaming}
          error={error}
          busy={busy}
          onRetry={retry}
          onRegenerate={regenerate}
          onEdit={edit}
          footer={
            chips && messages.at(-1)?.id === chips.messageId && !busy ? <Chips options={chips.options} onPick={send} /> : undefined
          }
        />
      )}

      <Composer
        conversationKey={activeId ?? "new"}
        busy={busy}
        onSend={send}
        onStop={stop}
        dock={
          fixture ? (
            <SketchDock sketch={fixture} canSwitch onToggle={(live) => setFixture({ ...fixture, live })} />
          ) : sketch?.name ? (
            // Keyed by conversation: opening another one brings its dock in fresh.
            <SketchDock
              key={activeId ?? "new"}
              sketch={sketchFromDTO(sketch)}
              sketching={sketchingTurn !== null}
              published={published?.slug ?? null}
              onPublish={() => {
                setPublishError(null);
                setSheetOpen(true);
              }}
            />
          ) : null
        }
      />

      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />

      <PublishSheet
        open={sheetOpen}
        name={sketch?.name ?? ""}
        description={firstUpper(sketch?.does)}
        inputHint={firstUpper(sketch?.takes)}
        handle={account && { current: account.handle, chosen: account.handleChosen }}
        checkHandle={api.checkHandle}
        currencies={currencies}
        busy={publishing}
        error={publishError}
        onCancel={() => setSheetOpen(false)}
        onPublish={doPublish}
      />

      <Dialog
        open={unpublishId !== null}
        onClose={() => setUnpublishId(null)}
        title="Take it off the board?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setUnpublishId(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={doUnpublish}>
              Take it down
            </Button>
          </>
        }
      >
        <p className={styles.confirmText}>It leaves the board and its page says it was taken down. The conversation stays.</p>
      </Dialog>

      <Dialog
        open={priceSlug !== null}
        onClose={() => !priceBusy && setPriceSlug(null)}
        title="Price per use"
        actions={
          <>
            <Button variant="ghost" onClick={() => setPriceSlug(null)} disabled={priceBusy}>
              Cancel
            </Button>
            <Button onClick={doSetPrice} disabled={priceBusy || Boolean(pricing.problem)}>
              {priceBusy ? "Saving..." : "Save"}
            </Button>
          </>
        }
      >
        <PriceFields currencies={currencies} drafts={priceDrafts} onChange={setPriceDrafts} disabled={priceBusy} problem={pricing.problem ?? priceError} />
      </Dialog>

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
        <p className={styles.confirmText}>
          This removes the conversation and its messages. It cannot be undone.
          {conversations.find((c) => c.id === deleteId)?.publishedSlug ? " Its helper comes off the board too." : ""}
        </p>
      </Dialog>
    </div>
  );
}

// The sheet's starting text, from the sketch's plain words.
function firstUpper(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : "";
}
