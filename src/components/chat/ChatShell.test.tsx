import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AccountDTO, ChatEvent } from "@/lib/types";
import { ToastProvider } from "@/components/ui";
import { ChatShell } from "./ChatShell";

// The chat shell with the network replaced: the test plays the server's
// events by hand to check what the person can do at each point.

const api = vi.hoisted(() => ({
  account: null as unknown,
  emit: null as null | ((e: ChatEvent) => void),
  sent: [] as Record<string, unknown>[],
  planned: [] as string[],
  // What the conversation holds, as the server would send it again.
  conversation: { messages: [] as unknown[], sketch: null as unknown, agent: null as unknown },
}));

vi.mock("@privy-io/react-auth", () => ({ usePrivy: () => ({ logout: () => {} }) }));
vi.mock("@/lib/useOpenServLink", () => ({ useOpenServLink: () => async () => {} }));
vi.mock("@/lib/publicApi", () => ({ fetchPayments: async () => ({ enabled: false, currencies: [] }), fetchHelper: async () => ({ missing: true }) }));
vi.mock("@/lib/useApi", () => {
  const client = {
    listConversations: async () => [],
    getAccount: async () => api.account,
    getConversation: async () => api.conversation,
    makeIt: async (conversationId: string) => {
      api.planned.push(conversationId);
      const agent = { id: "a1", version: 1, state: "draft", buildState: "planning", buildNote: null, steps: [], test: null, problem: null, plain: [] };
      api.conversation = { ...api.conversation, agent, messages: [...api.conversation.messages, { id: "k2", role: "assistant", content: "Working out the steps.", card: { stage: "steps", agentId: "a1" } }] };
      return agent;
    },
    getAgent: async () => ({ id: "a1", version: 1, state: "draft", buildState: "planning", buildNote: null, steps: [] }),
    sendChat: (body: Record<string, unknown>, on: (e: ChatEvent) => void) => {
      api.sent.push(body);
      api.emit = on;
      return () => {};
    },
  };
  return { useApi: () => client };
});
// The animated pieces are not what is under test.
vi.mock("./Thinking", () => ({ Thinking: () => <p>thinking</p> }));
vi.mock("./SketchDock", () => ({
  SketchDock: ({ sketch, sketching }: { sketch: { name: string; how: { value: string } }; sketching?: boolean }) => (
    <p data-testid="dock">{sketching ? "sketching..." : `sketched ${sketch.name}, how ${sketch.how.value || "-"}`}</p>
  ),
}));

const UNLINKED: AccountDTO = { email: "maya@example.com", handle: "maker_4821", handleChosen: false, walletAddress: null, openservUserId: null, linked: false, balance: "unknown" };

async function renderShell() {
  render(
    <ToastProvider>
      <ChatShell />
    </ToastProvider>,
  );
  await act(async () => {}); // the account and the list load
}

async function emit(...events: ChatEvent[]) {
  await act(async () => {
    for (const e of events) api.emit!(e);
    await new Promise((r) => setTimeout(r, 30)); // deltas land on the next frame
  });
}

beforeEach(() => {
  api.account = UNLINKED;
  api.sent = [];
  // Reduced motion: every animation helper steps aside.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SERV = { source: "serv", label: "SERV Reasoning" };
const ETH = { name: "ETH floor watch", kind: "watcher", watches: "ETH price", when: "below $2,000", how: null, tells: null, takes: null, does: null, gives: null, asking: "how", live: false } as const;
const answers = () => screen.queryByRole("group", { name: "Suggested answers" });

describe("ChatShell", () => {
  it("always shows New agent with its shortcut, and it starts a new chat", async () => {
    await renderShell();
    const button = screen.getByRole("button", { name: /^New agent/ });
    expect(button).toHaveAttribute("aria-keyshortcuts", "Meta+Shift+O Control+Shift+O");
    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Check my sheet every morning" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await emit({ type: "meta", conversationId: "c1", ...SERV }, { type: "delta", text: "Which sheet?" }, { type: "reply_end", messageId: "m1", ...SERV, choices: [] });
    expect(screen.getByRole("log")).toHaveTextContent("Which sheet?");
    fireEvent.click(button);
    expect(screen.queryByRole("log")).toBeNull();
    // The shortcut does the same.
    await emit();
    fireEvent.keyDown(window, { key: "o", metaKey: true, shiftKey: true });
    expect(screen.getByRole("button", { name: /^New agent/ })).toBeInTheDocument();
  });

  it("sends with no OpenServ link, from the composer and the examples", async () => {
    await renderShell();
    const input = screen.getByLabelText("Message boardofserv");
    expect(input).not.toBeDisabled();
    expect(screen.queryByText(/get replies from SERV/)).toBeNull();
    fireEvent.change(input, { target: { value: "Tell me when ETH drops" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(api.sent).toEqual([{ conversationId: undefined, content: "Tell me when ETH drops" }]);
  });

  it("fills the dock from the plan, then unlocks the composer at reply_end", async () => {
    api.account = { ...UNLINKED, linked: true, openservUserId: "1", walletAddress: "0x1", balance: "ok" };
    await renderShell();
    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Watch ETH" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    const sketch = { name: "ETH floor watch", kind: "watcher", watches: "ETH price", when: null, how: null, tells: null, takes: null, does: null, gives: null, asking: "tells", live: false } as const;
    await emit({ type: "sketch", conversationId: "c1", sketch });
    expect(screen.getByTestId("dock")).toHaveTextContent("sketched");
    await emit({ type: "meta", conversationId: "c1", source: "serv", label: "SERV Reasoning" }, { type: "delta", text: "Where should it tell you?" });
    expect(screen.getByLabelText("Stop generating")).toBeInTheDocument();

    await emit({ type: "reply_end", messageId: "m1", source: "serv", label: "SERV Reasoning", choices: ["Telegram", "Email"] });
    expect(screen.queryByLabelText("Stop generating")).toBeNull();
    expect(screen.getByRole("log")).toHaveTextContent("Where should it tell you?");
    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Telegram" } });
    expect(screen.getByLabelText("Send message")).not.toBeDisabled();
    expect(screen.getByRole("group", { name: "Suggested answers" })).toHaveTextContent("TelegramEmail");

    await emit({ type: "done", messageId: "m1", source: "serv", label: "SERV Reasoning" });
    // The reply settled once, at reply_end.
    expect(screen.getByRole("log").textContent?.split("Where should it tell you?")).toHaveLength(2);
  });

  it("shows sketching... on the dock while the plan runs", async () => {
    await renderShell();
    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Watch ETH" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    const sketch = { name: "ETH floor watch", kind: null, watches: "ETH price", when: null, how: null, tells: null, takes: null, does: null, gives: null, asking: null, live: false } as const;
    await emit({ type: "sketch", conversationId: "c1", sketch }, { type: "meta", conversationId: "c1", source: "serv", label: "SERV Reasoning" }, { type: "delta", text: "Noted." }, { type: "reply_end", messageId: "m1", source: "serv", label: "SERV Reasoning", choices: [] }, { type: "done", messageId: "m1", source: "serv", label: "SERV Reasoning" });
    expect(screen.getByTestId("dock")).toHaveTextContent("sketched");

    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Every minute" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await emit();
    expect(screen.getByTestId("dock")).toHaveTextContent("sketching...");
    await emit({ type: "sketch", conversationId: "c1", sketch: { ...sketch, how: "every minute" } });
    expect(screen.getByTestId("dock")).toHaveTextContent("sketched");
  });

  it("fills the dock while the thinking scribble shows, and shows the buttons only at reply_end", async () => {
    await renderShell();
    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Tell me when ETH drops below $2,000" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    // The plan's sketch arrives first: the dock fills in, the reply has not started.
    await emit({ type: "sketch", conversationId: "c1", sketch: ETH });
    expect(screen.getByTestId("dock")).toHaveTextContent("sketched ETH floor watch");
    expect(screen.getByText("thinking")).toBeInTheDocument();
    expect(answers()).toBeNull();

    await emit({ type: "meta", conversationId: "c1", ...SERV }, { type: "delta", text: "How often should it check the price?" });
    expect(screen.queryByText("thinking")).toBeNull();
    expect(answers()).toBeNull();

    await emit({ type: "reply_end", messageId: "m1", ...SERV, choices: ["Every minute", "Every hour"] });
    expect(answers()).toHaveTextContent("Every minuteEvery hour");

    // Tapping one sends it, and the buttons go.
    fireEvent.click(screen.getByText("Every hour"));
    expect(api.sent.at(-1)).toEqual({ conversationId: "c1", content: "Every hour" });
    expect(answers()).toBeNull();
  });

  it("after a failed plan, stops sketching when the reply starts and shows no buttons", async () => {
    await renderShell();
    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Watch ETH" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await emit({ type: "sketch", conversationId: "c1", sketch: ETH }, { type: "meta", conversationId: "c1", ...SERV }, { type: "delta", text: "How often?" }, { type: "reply_end", messageId: "m1", ...SERV, choices: [] }, { type: "done", messageId: "m1", ...SERV });

    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Every hour" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await emit();
    expect(screen.getByTestId("dock")).toHaveTextContent("sketching...");
    // No sketch event: the plan failed, and the reply starts anyway.
    await emit({ type: "meta", conversationId: "c1", ...SERV }, { type: "delta", text: "Got it. Where should it tell you?" });
    expect(screen.getByTestId("dock")).toHaveTextContent("sketched ETH floor watch, how -");
    await emit({ type: "reply_end", messageId: "m2", ...SERV, choices: [] }, { type: "done", messageId: "m2", ...SERV });
    expect(screen.getByRole("log")).toHaveTextContent("Got it. Where should it tell you?");
    expect(answers()).toBeNull();
  });

  it("says how many messages are left under the composer once fewer than 10 are, and nothing on an own key", async () => {
    const quota = (remaining: number) => ({ limit: 30, remaining, resetsAt: "2026-11-10T00:00:00.000Z" });
    api.account = { ...UNLINKED, chat: quota(10) };
    await renderShell();
    expect(screen.queryByText(/messages? left today/)).toBeNull();
    cleanup();

    api.account = { ...UNLINKED, chat: quota(9) };
    await renderShell();
    expect(screen.getByText("9 messages left today")).toHaveAttribute("role", "status");
    expect(screen.getByLabelText("Message boardofserv")).not.toBeDisabled();
    cleanup();

    api.account = { ...UNLINKED, chat: quota(1) };
    await renderShell();
    expect(screen.getByText("1 message left today")).toHaveAttribute("role", "status");
    cleanup();

    api.account = { ...UNLINKED, servKey: { last4: "9f2c" }, chat: null, paused: false };
    await renderShell();
    expect(screen.queryByText(/left today|reset at midnight/)).toBeNull();
  });

  it("pauses the composer, calmly, when the day's messages or the site's limit run out", async () => {
    api.account = { ...UNLINKED, chat: { limit: 30, remaining: 0, resetsAt: "2026-11-10T00:00:00.000Z" } };
    await renderShell();
    expect(screen.getByText("You've used today's 30 messages. They reset at midnight UTC.")).toHaveAttribute("role", "status");
    expect(screen.getByLabelText("Message boardofserv")).toBeDisabled();
    cleanup();

    api.account = { ...UNLINKED, chat: { limit: 30, remaining: 12, resetsAt: "2026-11-10T00:00:00.000Z" }, paused: true };
    await renderShell();
    expect(screen.getByText("boardofserv has hit today's limit. It resets at midnight UTC.")).toHaveAttribute("role", "status");
    expect(screen.getByLabelText("Message boardofserv")).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts a refused message back in the composer, with the limit under it", async () => {
    await renderShell();
    const input = screen.getByLabelText("Message boardofserv");
    fireEvent.change(input, { target: { value: "One more blurb" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("One more blurb")).toBeInTheDocument();
    api.account = { ...UNLINKED, paused: true };
    await emit({ type: "error", message: "boardofserv has hit today's limit. It resets at midnight UTC.", limit: "site" });
    // The message is not in the thread, it is back in the box.
    expect(screen.getByLabelText("Message boardofserv")).toHaveValue("One more blurb");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("boardofserv has hit today's limit. It resets at midnight UTC.")).toHaveAttribute("role", "status");
  });

  it("offers Make it as a card once an agent's job is clear, follows it to its steps, and keeps a helper's dock for a helper", async () => {
    await renderShell();
    // The six stages, faint before the first message.
    expect(screen.getByRole("navigation", { name: "Making your agent" })).toHaveAttribute("data-faint", "true");
    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Restock my fabric every morning" } });
    fireEvent.keyDown(screen.getByLabelText("Message boardofserv"), { key: "Enter" });
    const agentSketch = {
      ...ETH,
      name: "Fabric restock",
      kind: "agent" as const,
      watches: null,
      when: null,
      wakes: "every morning",
      looks: "the Stock sheet",
      handles: "orders what is low",
      finish: null,
      asks: null,
      setup: null,
      remembers: null,
      asking: null,
    };
    api.conversation = { messages: [{ id: "u1", role: "user", content: "Restock my fabric every morning" }, { id: "m1", role: "assistant", content: "Every morning it checks the Stock sheet." }, { id: "k1", role: "assistant", content: "I have what I need to make it.", card: { stage: "describe" } }], sketch: agentSketch, agent: null };
    await emit(
      { type: "sketch", conversationId: "c1", sketch: agentSketch },
      { type: "meta", conversationId: "c1", ...SERV },
      { type: "delta", text: "Every morning it checks the Stock sheet." },
      { type: "reply_end", messageId: "m1", ...SERV, choices: [] },
      { type: "card", conversationId: "c1", message: { id: "k1", role: "assistant", content: "I have what I need to make it.", card: { stage: "describe" }, createdAt: "2026-11-11T00:00:00.000Z" } },
      { type: "done", messageId: "m1", ...SERV },
    );
    // No dock for an agent: its stages are cards in the chat.
    expect(screen.queryByTestId("dock")).toBeNull();
    const describe = screen.getByRole("region", { name: "1. Describe" });
    expect(describe).toHaveTextContent("every morning");
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make it" }));
    });
    expect(api.planned).toEqual(["c1"]);
    expect(screen.getByRole("region", { name: "2. Steps" })).toHaveTextContent("Working out the steps");
    expect(screen.getByRole("navigation", { name: "Making your agent" })).not.toHaveAttribute("data-faint");

    // A helper's sketch keeps the helper's dock.
    api.conversation = { messages: [], sketch: null, agent: null };
    fireEvent.click(screen.getByRole("button", { name: /^New agent/ }));
    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "A blurb writer" } });
    fireEvent.keyDown(screen.getByLabelText("Message boardofserv"), { key: "Enter" });
    await emit({ type: "sketch", conversationId: "c2", sketch: { ...ETH, name: "Blurb writer", kind: "answer", asking: null } });
    expect(screen.getByTestId("dock")).toHaveTextContent("sketched Blurb writer");
  });
});
