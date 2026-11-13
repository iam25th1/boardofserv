import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConnectionDTO } from "@/lib/types";
import { ConnectionsView, type ConnectionsApi } from "./ConnectionsView";
import { GoogleConnect } from "./GoogleConnect";
import { TelegramLink } from "./TelegramLink";
import { TypeformConnect } from "./TypeformConnect";

// The connections page: what is linked, as what and since when, what uses
// it, Disconnect after a yes; and the ways to link Telegram and connect
// Google.

const telegram: ConnectionDTO = { provider: "telegram", name: "Telegram", label: "@shop", connectedAt: "2026-11-09T08:00:00Z", lastUsedAt: null, usedBy: [{ id: "i1", name: "Fabric restock", status: "active" }] };

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the connections page", () => {
  it("shows what is linked and what uses it, and disconnects after a yes, saying what paused", async () => {
    let linked = [telegram];
    const api = {
      load: vi.fn(async () => ({ connections: linked, available: { telegram: true, google: false, typeform: true } })),
      disconnect: vi.fn(async () => {
        linked = [];
        return { revoked: null, paused: 1 };
      }),
    } satisfies ConnectionsApi;
    render(<ConnectionsView api={api} connect={{ telegram: () => <p>link it here</p> }} />);
    expect(await screen.findByText("@shop")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fabric restock" })).toHaveAttribute("href", "/app/installations/i1");
    expect(screen.getByText("It isn't set up on this server.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByText("Fabric restock will pause until you connect it again.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" }).at(-1)!);
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith("telegram"));
    expect(await screen.findByText("Disconnected. 1 agent is paused until you connect it again.")).toBeInTheDocument();
    expect(await screen.findByText("link it here")).toBeInTheDocument();
  });

  it("links Telegram with a one-time code, looking again until the bot has it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const refresh = vi.fn(async () => {});
    const getCode = vi.fn(async () => ({ code: "ABCDEF2345", link: "https://t.me/boardofservbot?start=ABCDEF2345", bot: "boardofservbot", expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    render(<TelegramLink getCode={getCode} refresh={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Link Telegram" }));
    expect(await screen.findByText("/start ABCDEF2345")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Telegram with it" })).toHaveAttribute("href", "https://t.me/boardofservbot?start=ABCDEF2345");
    expect(screen.getByText(/It works once, for 10:00 more/)).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(refresh).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("goes to Google to connect, and says why when it can't", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const start = vi.fn(async () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=x" }));
    render(<GoogleConnect start={start} returnTo="/app/agents/a1?setup=1" />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Google" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=x"));
    expect(start).toHaveBeenCalledWith("/app/agents/a1?setup=1");
    cleanup();
    render(<GoogleConnect start={async () => Promise.reject(new Error("Google isn't set up here."))} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Google" }));
    expect(await screen.findByText("Google isn't set up here.")).toBeInTheDocument();
  });
  it("connects Typeform with a pasted token, clears it, and says why when Typeform turns it down", async () => {
    const onConnected = vi.fn();
    const connect = vi.fn(async (token: string) => (token === "tfp_good_token" ? { label: "Typeform (sample)" } : Promise.reject(new Error("That token didn't work with Typeform."))));
    render(<TypeformConnect connect={connect} onConnected={onConnected} />);
    const field = screen.getByLabelText("Your Typeform personal token");
    expect(field).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Connect Typeform" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "tfp_bad_token" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Typeform" }));
    expect(await screen.findByText("That token didn't work with Typeform.")).toBeInTheDocument();
    expect(onConnected).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: " tfp_good_token " } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Typeform" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(connect).toHaveBeenLastCalledWith("tfp_good_token");
    expect(field).toHaveValue("");
  });
});
