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
}));

vi.mock("@privy-io/react-auth", () => ({ usePrivy: () => ({ logout: () => {} }) }));
vi.mock("@/lib/useOpenServLink", () => ({ useOpenServLink: () => async () => {} }));
vi.mock("@/lib/publicApi", () => ({ fetchPayments: async () => ({ enabled: false, currencies: [] }), fetchHelper: async () => ({ missing: true }) }));
vi.mock("@/lib/useApi", () => {
  const client = {
    listConversations: async () => [],
    getAccount: async () => api.account,
    getConversation: async () => ({ messages: [], sketch: null }),
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
});
