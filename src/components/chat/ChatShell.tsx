"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useApi } from "@/lib/useApi";
import type { AccountDTO, AgentSummaryDTO, ConversationDTO } from "@/lib/types";
import { Button, Dialog, TextInput, useToast } from "@/components/ui";
import { PlusIcon } from "@/components/icons";
import { SHORTCUTS_EVENT } from "@/components/shell/AppShell";
import { useShellAccount } from "@/components/shell/AccountContext";
import { AgentsPill, type AgentsPillHandle } from "./AgentsPill";
import { MessageList, type StreamingView } from "./MessageList";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { SketchDock } from "./SketchDock";
import { StageTracker } from "./journey/StageTracker";
import { ConnectProblem, JourneyCardView, type JourneyApi } from "./journey/JourneyCards";
import { stageOf, type JourneyCard, type Stage } from "@/lib/journey";
import { describedEnough } from "@/lib/sketchFields";
import { Chips } from "./Chips";
import { PublishSheet, type PublishEdits } from "./PublishSheet";
import { PriceFields, draftsOf, readPrices, type PriceDrafts } from "./PriceFields";
import { fetchHelper, fetchPayments } from "@/lib/publicApi";
import { sketchFromDTO, type AgentSketch } from "@/lib/agentSketch";
import { chatLimitMessage, FEW_MESSAGES, LIMIT_MESSAGE, messagesLeft } from "@/lib/limits";
import type { CurrencyDTO, PublicHelperDTO, SketchDTO } from "@/lib/types";
import type { MessageView } from "./Message";
import styles from "./ChatShell.module.css";

export function ChatShell({ initialAccount = null }: { initialAccount?: AccountDTO | null } = {}) {
  const api = useApi();
  const toast = useToast();

  const [conversations, setConversations] = useState<ConversationDTO[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [streaming, setStreaming] = useState<StreamingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountDTO | null>(initialAccount);
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
  // The agent made in the active conversation, as its cards show it.
  const [agent, setAgent] = useState<AgentSummaryDTO | null>(null);
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
  // A turn the day's limits refused before it was stored, until the account
  // says so too; and its text, put back in the composer.
  const [refused, setRefused] = useState<string | null>(null);
  const [putBack, setPutBack] = useState<{ text: string; nonce: number } | null>(null);

  // Where the conversation being opened was scrolled to when it was left.
  const [restore, setRestore] = useState<{ key: string; top: number } | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  // Deltas are gathered and applied once per animation frame, so a fast
  // stream renders (and dusts in) in a few batches, not a word at a time.
  const pendingRef = useRef("");
  const frameRef = useRef<number | null>(null);
  const agentsRef = useRef<AgentsPillHandle>(null);
  // The new agent shortcut's modifier, once the browser says which it is.
  const [mod, setMod] = useState<"Cmd" | "Ctrl" | null>(null);
  useEffect(() => setMod(/Mac|iPhone|iPad/i.test(navigator.platform) ? "Cmd" : "Ctrl"), []);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await api.listConversations());
    } catch {
      // list stays as it was; a transient error should not blank the agents list
    }
  }, [api]);

  // The chat keeps its own copy of the account (its limits, the publish
  // sheet) and the shell keeps one for the account menu. The shell's comes
  // down by the effect below; what the chat learns goes up where it learns
  // it. Kept in step by an effect each way, the two copies (each read from
  // the server on load, so never the same object) swapped places on every
  // render, for good: the page never settled, and a link's navigation, which
  // waits for it to, never happened.
  const shell = useShellAccount();
  const shareAccount = shell.setAccount;

  const refreshAccount = useCallback(async () => {
    try {
      const fresh = await api.getAccount();
      setAccount(fresh);
      shareAccount(fresh);
      setRefused(null);
    } catch {
      setAccount(null);
    }
  }, [api, shareAccount]);

  // The shell's account menu asks for the shortcuts.
  useEffect(() => {
    const open = () => setShortcuts(true);
    window.addEventListener(SHORTCUTS_EVENT, open);
    return () => window.removeEventListener(SHORTCUTS_EVENT, open);
  }, []);
  useEffect(() => {
    if (shell.account) setAccount(shell.account);
  }, [shell.account]);

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
      remember(id);
      setRestore({ key: id, top: scrollOf(id) });
      setError(null);
      try {
        const { messages: rows, sketch: stored, published: helper, agent: builtAgent } = await api.getConversation(id);
        // Another conversation was opened while this one loaded.
        if (activeRef.current !== id) return;
        setMessages(rows.map(toView));
        setSketch(stored);
        setPublished(helper ?? null);
        setAgent(builtAgent ?? null);
        setChips(null);
      } catch {
        if (activeRef.current !== id) return;
        setMessages([]);
        setSketch(null);
        setPublished(null);
        setAgent(null);
      }
    },
    [api, abortReply],
  );

  const startNew = useCallback(() => {
    abortReply();
    setActiveId(null);
    activeRef.current = null;
    remember(null);
    setMessages([]);
    setSketch(null);
    setPublished(null);
    setAgent(null);
    setChips(null);
    setError(null);
    setTimeout(() => (document.querySelector("[data-composer-input]") as HTMLTextAreaElement | null)?.focus(), 30);
  }, [abortReply]);

  // Opening the chat: the conversation in the address (Back from another
  // page, or the way back from Google), else the last one open, unless the
  // maker last started a new one; never a blank chat they didn't ask for.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    const asked = new URLSearchParams(window.location.search).get("c");
    if (asked) {
      opened.current = true;
      void openConversation(asked);
      return;
    }
    if (new URLSearchParams(window.location.search).has("new")) {
      opened.current = true;
      return;
    }
    let live = true;
    api.listConversations().then(
      (list) => {
        if (!live || opened.current || activeRef.current) return;
        opened.current = true;
        const last = lastChat();
        const pick = last === "" ? null : (list.find((c) => c.id === last) ?? list[0] ?? null);
        if (pick) void openConversation(pick.id);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, openConversation]);

  const run = useCallback(
    (body: { conversationId?: string; content?: string; regenerate?: boolean; editMessageId?: string }, sent?: { id: string; text: string }) => {
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
          remember(id);
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
      const endReply = (messageId: string | undefined, source: string | null, label: string | null, choices: string[] = []) => {
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
        } else if (e.type === "agent") {
          // A change asked in the chat: the cards follow it from here.
          adopt(e.conversationId);
          if (convoId === activeRef.current) setAgent(e.agent);
        } else if (e.type === "card") {
          // Make it, under the reply that has what it needs.
          adopt(e.conversationId);
          if (convoId === activeRef.current) setMessages((prev) => [...prev.filter((m) => m.card?.stage !== "describe"), toView(e.message)]);
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
          if (e.limit) {
            // Nothing was stored: the message goes back into the composer and
            // the limit shows under it.
            setRefused(e.message);
            if (sent) {
              setMessages((prev) => prev.filter((m) => m.id !== sent.id));
              setPutBack({ text: sent.text, nonce: Date.now() });
            }
            void refreshAccount();
            return;
          }
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
      run({ conversationId: activeId ?? undefined, content: text }, { id: optimistic.id, text });
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
      const kept = prev.filter((m) => m.card?.stage !== "describe");
      const idx = [...kept].reverse().findIndex((m) => m.role === "assistant" && !m.card);
      if (idx === -1) return prev;
      return kept.slice(0, kept.length - 1 - idx);
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

  // Use your own SERV key, or stop: either way the limits shown change.
  const saveServKey = useCallback(
    async (key: string) => {
      await api.setServKey(key);
      await refreshAccount();
      toast.show({ title: "Your SERV key is in use" });
    },
    [api, refreshAccount, toast],
  );

  const removeServKey = useCallback(async () => {
    await api.removeServKey();
    await refreshAccount();
    toast.show({ title: "Your SERV key is removed" });
  }, [api, refreshAccount, toast]);

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
      shareAccount((a) => a && { ...a, handle: saved.handle, handleChosen: saved.handleChosen });
    },
    [api, shareAccount],
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

  // The maker switches the sketch's kind on the dock: shown at once, put
  // back if the server says no.
  const doKind = useCallback(
    async (kind: NonNullable<SketchDTO["kind"]>) => {
      const id = activeId;
      if (!id || !sketch) return;
      const before = sketch;
      setSketch({ ...sketch, kind, kindChosen: true });
      try {
        const saved = await api.setSketchKind(id, kind);
        if (activeRef.current === id) setSketch(saved);
      } catch (err) {
        if (activeRef.current === id) setSketch(before);
        toast.show({ title: err instanceof Error ? err.message : "The kind could not be changed. Try again.", tone: "danger" });
      }
    },
    [api, activeId, sketch, toast],
  );

  // The journey in the chat (journey/JourneyCards.tsx): each card's action
  // goes to the server, which puts the next card in; the conversation is
  // read again to show it.
  const reload = useCallback(async () => {
    const id = activeRef.current;
    if (!id) return;
    try {
      const { messages: rows, agent: now } = await api.getConversation(id);
      if (activeRef.current !== id) return;
      setMessages((prev) => (sameCards(prev, rows) && prev.length === rows.length ? prev : rows.map(toView)));
      setAgent(now ?? null);
    } catch {
      // The cards stay as they were; the next look tries again.
    }
  }, [api]);
  const cards = messages.filter((m) => m.card);
  // An agent made before the chat had its stages (no cards): its card comes
  // at the end, where the journey picks up again: its steps, with Looks
  // right, or Make it once the job is clear.
  const shown = useMemo<MessageView[]>(() => {
    if (!activeId || cards.length) return messages;
    const virtual: JourneyCard | null = agent?.steps.length ? { stage: "steps", agentId: agent.id } : !agent && describedEnough(sketch) ? { stage: "describe" } : null;
    return virtual ? [...messages, { id: `card-${virtual.stage}`, role: "assistant", content: "", card: virtual }] : messages;
  }, [activeId, cards.length, messages, agent, sketch]);

  const at: Stage = stageOf(shown.map((m) => m.card));
  const asking = agent?.heal?.question ?? null;
  const latestCard = cards.at(-1)?.card ?? null;
  const live = Boolean(latestCard?.live?.installationId || latestCard?.live?.listed);
  const journey = useMemo<JourneyApi>(
    () => ({
      makeIt: async () => {
        const id = activeRef.current;
        if (!id) return;
        setAgent(await api.makeIt(id));
        await reload();
      },
      looksRight: async () => {
        if (!agent) return;
        setAgent(await api.looksRight(agent.id));
        await reload();
      },
      change: async (text: string) => {
        if (!agent) return;
        setAgent(await api.changeSteps(agent.id, text));
        await reload();
      },
      fix: async (change: { message: string } | { step: string }) => {
        if (!agent) return;
        setAgent(await api.fixIt(agent.id, change));
        await reload();
      },
      retry: async () => {
        if (!agent) return;
        await api.testAgent(agent.id, { journey: true });
        await reload();
      },
      connect: async (answers: Parameters<JourneyApi["connect"]>[0]) => {
        const id = activeRef.current;
        if (!id) return;
        try {
          await api.connect(id, answers);
        } catch (err) {
          const errors = (err as { errors?: Record<string, string> | null }).errors;
          if (errors) throw new ConnectProblem(err instanceof Error ? err.message : "Some answers need another look.", errors);
          throw err;
        }
        await reload();
      },
      goLive: async (body: Parameters<JourneyApi["goLive"]>[0]) => {
        if (!agent) return;
        await api.goLive(agent.id, body);
        await reload();
      },
      simpler: async () => {
        const id = activeRef.current;
        if (!id) return;
        setAgent(await api.simpler(id));
        await reload();
      },
      // A new chat, its box holding what the maker first said, to word again.
      describeAgain: () => {
        const first = messages.find((m) => m.role === "user")?.content ?? "";
        startNew();
        setPutBack({ text: first, nonce: Date.now() });
      },
      installation: api.getInstallation,
      connections: api.listConnections,
      telegramCode: api.telegramCode,
      googleStart: api.googleStart,
      inspectSheet: api.inspectSheet,
    }),
    [api, agent, reload, messages, startNew],
  );

  // While something is under way (steps being worked out, built or tried),
  // the cards are read again every two seconds until it settles.
  const busyNow = agent !== null && ["planning", "writing", "fixing"].includes(agent.buildState);
  const waiting = busyNow || (at === "try" && !agent?.test && agent?.buildState !== "idle");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void reload(), 2000);
    return () => clearInterval(timer);
  }, [waiting, reload]);

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


  // Where this conversation is scrolled to, kept for coming back to it.
  const keepScroll = useCallback((top: number) => {
    if (activeRef.current) keepScrollOf(activeRef.current, top);
  }, []);

  // The day's limits, from the account: own-key accounts have none.
  const blocked = refused ?? (account?.paused ? LIMIT_MESSAGE : account?.chat?.remaining === 0 ? chatLimitMessage(account.chat) : null);
  const notice = blocked ?? (account?.chat && account.chat.remaining < FEW_MESSAGES ? messagesLeft(account.chat.remaining) : null);

  return (
    <div className={styles.app}>
      {/* The app shell has the top bar; the chat's own row holds its
          conversations. A first visit, with none yet, shows only the
          sentence, the examples and the way ahead. */}
      {(conversations.length > 0 || activeId || messages.length > 0) && (
      <div className={styles.row}>
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
        {/* A new agent, always in view, and its shortcut beside it. */}
        <button type="button" className={styles.newAgent} onClick={startNew} aria-keyshortcuts="Meta+Shift+O Control+Shift+O">
          <PlusIcon size={16} />
          <span>New agent</span>
          {mod && (
            <span className={styles.keys} aria-hidden="true">
              <kbd>{mod}</kbd>
              <kbd>Shift</kbd>
              <kbd>O</kbd>
            </span>
          )}
        </button>
      </div>
      )}

      {/* Making an agent, in six stages: faint until there is a job. */}
      {sketch?.kind !== "answer" && <StageTracker at={at} live={live} faint={messages.length === 0 && !streaming} />}

      {messages.length === 0 && !streaming ? (
        <EmptyState onPick={send} disabled={busy || Boolean(blocked)} />
      ) : (
        <MessageList
          restore={restore}
          onScrolled={keepScroll}
          streaming={streaming}
          error={error}
          busy={busy}
          onRetry={retry}
          onRegenerate={regenerate}
          onEdit={edit}
          messages={shown}
          renderCard={(m) =>
            m.card && activeId ? (
              <JourneyCardView card={m.card} latest={m.id === shown.filter((x) => x.card).at(-1)?.id} agent={agent} sketch={sketch} conversationId={activeId} api={journey} />
            ) : null
          }
          footer={
            // The fixer's question, under the message that asks it, with
            // its answers to tap; else the latest reply's suggestions.
            asking && messages.at(-1)?.id === asking.messageId && !busy ? (
              <Chips options={asking.choices} onPick={send} />
            ) : chips && messages.at(-1)?.id === chips.messageId && !busy ? (
              <Chips options={chips.options} onPick={send} />
            ) : undefined
          }
        />
      )}

      <Composer
        conversationKey={activeId ?? "new"}
        busy={busy}
        disabled={Boolean(blocked) && !busy}
        placeholder={blocked ? "Back after midnight UTC" : PLACEHOLDER[at] ?? undefined}
        notice={notice}
        prefill={putBack?.text}
        prefillNonce={putBack?.nonce}
        onSend={send}
        onStop={stop}
        dock={
          fixture ? (
            <SketchDock sketch={fixture} canSwitch onToggle={(live) => setFixture({ ...fixture, live })} />
          ) : sketch?.name && sketch.kind !== "agent" && !agent ? (
            // An answer helper's sketch, with Publish. Keyed by conversation:
            // opening another one brings its dock in fresh. An agent's
            // stages are cards in the chat instead.
            <SketchDock
              key={activeId ?? "new"}
              sketch={sketchFromDTO(sketch)}
              sketching={sketchingTurn !== null}
              published={published?.slug ?? null}
              onKind={(kind) => void doKind(kind)}
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

// A stored message as the list shows it, a stage card with its card.
function toView(m: { id: string; role: "user" | "assistant"; content: string; source?: string | null; sourceLabel?: string | null; card?: JourneyCard | null }): MessageView {
  return { id: m.id, role: m.role, content: m.content, source: m.source ?? null, sourceLabel: m.sourceLabel ?? null, card: m.card ?? null };
}

// Whether the stored messages show the same cards the list has: nothing to
// redraw.
function sameCards(shown: MessageView[], stored: { id: string; content: string; card?: JourneyCard | null }[]): boolean {
  return shown.every((m, i) => m.id === stored[i]?.id && m.content === stored[i]?.content && JSON.stringify(m.card ?? null) === JSON.stringify(stored[i]?.card ?? null));
}

// What the composer invites at each stage.
const PLACEHOLDER: Partial<Record<Stage, string>> = {
  steps: "Ask anything, or say what should change",
  build: "Ask anything while it builds",
  try: "Ask anything, or say what's wrong",
  connect: "Ask anything about connecting it",
  live: "Ask anything about it",
};

// The conversation open now, in the address (so Back and a reload come back
// to it) and remembered for the next time the chat opens; null for a new
// one, which the chat then opens blank.
const LAST_CHAT = "bos-last-chat";
function remember(id: string | null): void {
  try {
    window.history.replaceState(window.history.state, "", id ? `/app/chat?c=${encodeURIComponent(id)}` : "/app/chat?new=1");
  } catch {
    // An address that can't change: Back still comes to the chat.
  }
  try {
    window.localStorage.setItem(LAST_CHAT, id ?? "");
  } catch {
    // Private windows: the chat opens on the newest conversation instead.
  }
}
function lastChat(): string | null {
  try {
    return window.localStorage.getItem(LAST_CHAT);
  } catch {
    return null;
  }
}

// Where each conversation was scrolled to, for this tab.
function scrollOf(id: string): number {
  try {
    return Number(window.sessionStorage.getItem(`bos-scroll:${id}`) ?? "-1");
  } catch {
    return -1;
  }
}
function keepScrollOf(id: string, top: number): void {
  try {
    window.sessionStorage.setItem(`bos-scroll:${id}`, String(Math.round(top)));
  } catch {
    // Without storage it opens at the latest message.
  }
}
