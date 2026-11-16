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

const telegram: ConnectionDTO = { provider: "telegram", name: "Telegram", label: "@shop", writes: true, connectedAt: "2026-11-09T08:00:00Z", lastUsedAt: null, usedBy: [{ id: "i1", name: "Fabric restock", status: "active" }] };

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

  it("lists every service by category, finds one by what it is called, and offers Custom API for the rest", async () => {
    const api = { load: vi.fn(async () => ({ connections: [], available: {} })), disconnect: vi.fn() } satisfies ConnectionsApi;
    render(<ConnectionsView api={api} />);
    expect(await screen.findByRole("heading", { name: "Code and work" })).toBeInTheDocument();
    for (const name of ["Messages", "Forms and data", "Shops and payments", "Crypto", "Scheduling and customers", "Your own"]) expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "GitHub" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Find a service"), { target: { value: "repos" } });
    expect(screen.getByRole("heading", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Discord" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Find a service"), { target: { value: "mastodon" } });
    expect(screen.getByText(/Nothing here goes by/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "use Custom API" }));
    expect(screen.getByRole("heading", { name: "Custom API" })).toBeInTheDocument();
    // A service with nothing to connect says so.
    fireEvent.change(screen.getByLabelText("Find a service"), { target: { value: "coingecko" } });
    expect(screen.getByText(/Nothing to connect\. Prices are public\./)).toBeInTheDocument();
  });

  it("connects a service with its key, saying where to get one and why one was turned down", async () => {
    let linked: ConnectionDTO[] = [];
    const connect = vi.fn(async (_p: string, fields: Record<string, string>) => {
      if (fields.url !== "https://discord.com/api/webhooks/1/abc") throw new Error("That webhook didn't work with Discord: check the webhook still exists, or copy its address again.");
      linked = [{ provider: "discord", name: "Discord", label: "Discord (Builds)", writes: false, connectedAt: "2026-11-16T08:00:00Z", lastUsedAt: null, usedBy: [] }];
      return { label: "Discord (Builds)" };
    });
    const onConnected = vi.fn();
    const api = { load: vi.fn(async () => ({ connections: linked, available: {} })), disconnect: vi.fn(), connect } satisfies ConnectionsApi;
    render(<ConnectionsView api={api} focus="discord" onConnected={onConnected} />);
    // Sent here to connect it: its form is open.
    const field = await screen.findByLabelText("Webhook URL");
    expect(field).toHaveAttribute("type", "password");
    expect(screen.getByRole("link", { name: "Where to get it" })).toHaveAttribute("href", "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks");
    fireEvent.change(field, { target: { value: "https://discord.com/api/webhooks/1/nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Discord" }));
    expect(await screen.findByText("That webhook didn't work with Discord: check the webhook still exists, or copy its address again.")).toBeInTheDocument();
    fireEvent.change(field, { target: { value: " https://discord.com/api/webhooks/1/abc " } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Discord" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith("discord"));
    expect(connect).toHaveBeenLastCalledWith("discord", { url: "https://discord.com/api/webhooks/1/abc" });
    expect(await screen.findByText("Discord (Builds)")).toBeInTheDocument();
  });

  it("lets agents write through a connection only once its owner turns the switch on", async () => {
    let writes = false;
    const github = (): ConnectionDTO => ({ provider: "github", name: "GitHub", label: "GitHub (ada)", writes, connectedAt: "2026-11-16T08:00:00Z", lastUsedAt: null, usedBy: [] });
    const setWrites = vi.fn(async (_p: string, on: boolean) => {
      writes = on;
      return { writes: on };
    });
    const api = { load: vi.fn(async () => ({ connections: [github()], available: {} })), disconnect: vi.fn(), setWrites } satisfies ConnectionsApi;
    render(<ConnectionsView api={api} />);
    const toggle = await screen.findByRole("switch", { name: "Agents only read GitHub" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(setWrites).toHaveBeenCalledWith("github", true));
    expect(await screen.findByText("Your agents may now write to GitHub, still asking first wherever you or the agent said to.")).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Agents may write to GitHub" })).toHaveAttribute("aria-checked", "true");
    // A service that only reads has no switch.
    expect(screen.queryByRole("switch", { name: /Typeform/ })).toBeNull();
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
