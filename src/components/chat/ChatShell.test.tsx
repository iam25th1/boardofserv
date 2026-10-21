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
  SketchDock: ({ sketching }: { sketching?: boolean }) => <p data-testid="dock">{sketching ? "sketching..." : "sketched"}</p>,
}));

const UNLINKED: AccountDTO = { email: "maya@example.com", walletAddress: null, openservUserId: null, linked: false, balance: "unknown" };

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

  it("unlocks the composer at reply_end, before the sketch and done", async () => {
    api.account = { ...UNLINKED, linked: true, openservUserId: "1", walletAddress: "0x1", balance: "ok" };
    await renderShell();
    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Watch ETH" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await emit({ type: "meta", conversationId: "c1", source: "serv", label: "SERV Reasoning" }, { type: "delta", text: "Where should it tell you?" });
    expect(screen.getByLabelText("Stop generating")).toBeInTheDocument();

    await emit({ type: "reply_end", messageId: "m1", source: "serv", label: "SERV Reasoning" });
    expect(screen.queryByLabelText("Stop generating")).toBeNull();
    expect(screen.getByRole("log")).toHaveTextContent("Where should it tell you?");
    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Telegram" } });
    expect(screen.getByLabelText("Send message")).not.toBeDisabled();

    const sketch = { name: "ETH floor watch", kind: "watcher", watches: "ETH price", when: null, how: null, tells: null, asking: "tells", live: false } as const;
    await emit({ type: "sketch", sketch, choices: ["Telegram", "Email"] });
    expect(screen.getByTestId("dock")).toHaveTextContent("sketched");
    expect(screen.getByRole("group", { name: "Suggested answers" })).toHaveTextContent("TelegramEmail");

    await emit({ type: "done", messageId: "m1", source: "serv", label: "SERV Reasoning" });
    // The reply settled once, at reply_end.
    expect(screen.getByRole("log").textContent?.split("Where should it tell you?")).toHaveLength(2);
  });

  it("shows sketching... on the dock between reply_end and the sketch", async () => {
    await renderShell();
    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Watch ETH" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    const sketch = { name: "ETH floor watch", kind: null, watches: "ETH price", when: null, how: null, tells: null, asking: null, live: false } as const;
    await emit({ type: "meta", conversationId: "c1", source: "serv", label: "SERV Reasoning" }, { type: "delta", text: "Noted." }, { type: "reply_end", messageId: "m1", source: "serv", label: "SERV Reasoning" }, { type: "sketch", sketch, choices: [] }, { type: "done", messageId: "m1", source: "serv", label: "SERV Reasoning" });
    expect(screen.getByTestId("dock")).toHaveTextContent("sketched");

    fireEvent.change(screen.getByLabelText("Message boardofserv"), { target: { value: "Every minute" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await emit({ type: "delta", text: "Every minute. Where to?" }, { type: "reply_end", messageId: "m2", source: "serv", label: "SERV Reasoning" });
    expect(screen.getByTestId("dock")).toHaveTextContent("sketching...");
    await emit({ type: "sketch", sketch: { ...sketch, how: "every minute" }, choices: [] });
    expect(screen.getByTestId("dock")).toHaveTextContent("sketched");
  });
});
