import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Providers } from "./providers";
import ChatPage from "./app/chat/page";
import LoginPage from "./login/page";
import { SignInStalled, STALLED_TEXT } from "@/components/SignInStalled";
import type { AccountDTO } from "@/lib/types";

// Privy is replaced with a marker, so the tests can see whether it was mounted
// and whether a page asked it for the session.
const privy = vi.hoisted(() => ({
  usePrivy: vi.fn(() => ({ ready: false, authenticated: false, login: () => {}, logout: async () => {} })),
  config: null as unknown,
}));
const account = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children, config }: { children: ReactNode; config: unknown }) => {
    privy.config = config;
    return <div data-testid="privy">{children}</div>;
  },
  usePrivy: privy.usePrivy,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {} }) }));
vi.mock("@/components/chat/ChatShell", () => ({ ChatShell: () => <p>the chat</p> }));
vi.mock("@/lib/useApi", () => {
  const client = { getAccount: async () => account.current };
  return { useApi: () => client };
});

const UNSET = /sign-in isn't set up/i;

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  privy.usePrivy.mockClear();
  privy.usePrivy.mockImplementation(() => ({ ready: false, authenticated: false, login: () => {}, logout: async () => {} }));
});

describe.each(["", "ci-placeholder"])("with the Privy app id set to %j", (id) => {
  it("does not mount Privy", () => {
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", id);
    render(
      <Providers>
        <p>page</p>
      </Providers>,
    );
    expect(screen.getByText("page")).toBeInTheDocument();
    expect(screen.queryByTestId("privy")).toBeNull();
  });

  it("shows the sign-in setup screen on the chat and sign-in pages", () => {
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", id);
    render(<ChatPage />);
    expect(screen.getByRole("heading", { name: UNSET })).toBeInTheDocument();
    cleanup();
    render(<LoginPage />);
    expect(screen.getByRole("heading", { name: UNSET })).toBeInTheDocument();
    expect(privy.usePrivy).not.toHaveBeenCalled();
  });
});

describe("with a real Privy app id", () => {
  it("mounts Privy around the app", () => {
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "x".repeat(25));
    render(
      <Providers>
        <p>page</p>
      </Providers>,
    );
    expect(screen.getByTestId("privy")).toContainElement(screen.getByText("page"));
  });

  it("asks Privy 3 for sign-in by email and an embedded Ethereum wallet for everyone, in its v3 shape", () => {
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "x".repeat(25));
    render(
      <Providers>
        <p>page</p>
      </Providers>,
    );
    expect(privy.config).toMatchObject({
      loginMethods: ["email"],
      embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
      appearance: { walletList: [], landingHeader: "Sign in to boardofserv" },
    });
    // No smart wallets, and nothing of Solana's.
    const config = privy.config as { embeddedWallets: object; smartWallets?: unknown; externalWallets?: unknown };
    expect(Object.keys(config.embeddedWallets)).toEqual(["ethereum"]);
    expect(config.smartWallets).toBeUndefined();
    expect(config.externalWallets).toBeUndefined();
  });

  it("signs in by email from the sign-in page once Privy is ready", async () => {
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "x".repeat(25));
    const login = vi.fn();
    privy.usePrivy.mockImplementation(() => ({ ready: true, authenticated: false, login, logout: async () => {} }));
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with email" }));
    expect(login).toHaveBeenCalledOnce();
  });

  it("runs the chat page as before: it waits on the Privy session", () => {
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "x".repeat(25));
    render(<ChatPage />);
    expect(privy.usePrivy).toHaveBeenCalled();
    expect(screen.getByText("getting your workspace ready")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: UNSET })).toBeNull();
  });
});

describe("when Privy can't load", () => {
  it("replaces the loader after 10 seconds with what to do, and a retry", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "x".repeat(25));
    for (const Page of [ChatPage, LoginPage]) {
      render(<Page />);
      await act(async () => vi.advanceTimersByTime(9_999));
      expect(screen.queryByText(STALLED_TEXT)).toBeNull();
      await act(async () => vi.advanceTimersByTime(1));
      expect(screen.getByRole("alert")).toHaveTextContent(STALLED_TEXT);
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      cleanup();
    }
    expect(STALLED_TEXT).toBe("Sign-in couldn't load. If you use Brave or an ad blocker, allow this site, then try again.");
  });

  it("never shows it when Privy is ready in time", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "x".repeat(25));
    privy.usePrivy.mockImplementation(() => ({ ready: true, authenticated: false, login: () => {}, logout: async () => {} }));
    render(<LoginPage />);
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(screen.queryByText(STALLED_TEXT)).toBeNull();
    expect(screen.getByRole("button", { name: "Continue with email" })).toBeEnabled();
  });

  it("retries by loading the page again", () => {
    const retry = vi.fn();
    render(<SignInStalled onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("invite-only, signed in", () => {
  const base: AccountDTO = { email: "jo@example.com", handle: "maker_2207", handleChosen: false, walletAddress: null, openservUserId: null, linked: false, balance: "unknown" };

  async function signedIn(access: AccountDTO["access"]) {
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "x".repeat(25));
    privy.usePrivy.mockImplementation(() => ({ ready: true, authenticated: true, login: () => {}, logout: async () => {} }));
    account.current = { ...base, access };
    render(<ChatPage />);
    await act(async () => {});
  }

  it("shows a waiting account the waitlist, not the chat, with the board still open", async () => {
    await signedIn("waiting");
    expect(screen.getByRole("heading", { name: "You're on the list" })).toBeInTheDocument();
    expect(screen.getByText(/signed in as jo@example.com/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See the board" })).toHaveAttribute("href", "/app/board");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByText("the chat")).toBeNull();
  });

  it("tells an account turned away, calmly", async () => {
    await signedIn("rejected");
    expect(screen.getByRole("heading", { name: "Not open to you yet" })).toBeInTheDocument();
    expect(screen.queryByText("the chat")).toBeNull();
  });

  it("opens the chat for an account let in", async () => {
    await signedIn("approved");
    expect(screen.getByText("the chat")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "You're on the list" })).toBeNull();
  });
});
