import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { ToastProvider } from "@/components/ui";
import type { AccountDTO } from "@/lib/types";
import { AppShell } from "./AppShell";

// The app's shell: the same top bar on every page, the places with
// the current one marked, and an account button with the initial and the
// @handle (or a way to sign in).

const net = vi.hoisted(() => ({ signedIn: true, path: "/app/board", account: null as unknown }));

vi.mock("@/lib/privy-config", () => ({ privyAppId: () => "app-id-for-the-shell-test" }));
vi.mock("@privy-io/react-auth", () => ({ usePrivy: () => ({ ready: true, authenticated: net.signedIn, logout: async () => {} }) }));
vi.mock("next/navigation", () => ({ usePathname: () => net.path }));
vi.mock("@/lib/useApi", () => {
  const client = { getAccount: async () => net.account, countApprovals: async () => 0 };
  return { useApi: () => client };
});

const ACCOUNT: AccountDTO = { email: "maya@example.com", handle: "maya_r", handleChosen: true, walletAddress: null, openservUserId: null, linked: false, balance: "unknown", admin: false };

async function show(path: string) {
  net.path = path;
  render(
    <ToastProvider>
      <AppShell>
        <p>the page</p>
      </AppShell>
    </ToastProvider>,
  );
  await act(async () => {});
}

afterEach(cleanup);

describe("the app shell", () => {
  it("has the places, marks where you are, and holds the page", async () => {
    net.account = ACCOUNT;
    await show("/app/installations/abc");
    const nav = screen.getAllByRole("navigation", { name: "The app" })[0]!;
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Chat", "Board", "Your agents"]);
    expect(within(nav).getByRole("link", { name: "Your agents" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Board" })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("the page")).toBeInTheDocument();
  });

  it("shows the account's initial and @handle on its button, not a lone letter", async () => {
    net.account = ACCOUNT;
    await show("/app/board");
    const button = screen.getByRole("button", { name: /^Account, @maya_r/ });
    expect(button).toHaveTextContent("M@maya_r");
  });

  it("offers sign-in to someone signed out, coming back to the same page", async () => {
    net.signedIn = false;
    await show("/app/board");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?next=%2Fapp%2Fboard");
    net.signedIn = true;
  });
});
