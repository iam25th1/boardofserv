import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Providers } from "./providers";
import ChatPage from "./chat/page";
import LoginPage from "./login/page";

// Privy is replaced with a marker, so the tests can see whether it was mounted
// and whether a page asked it for the session.
const privy = vi.hoisted(() => ({
  usePrivy: vi.fn(() => ({ ready: false, authenticated: false, login: () => {} })),
}));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => <div data-testid="privy">{children}</div>,
  usePrivy: privy.usePrivy,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {} }) }));
vi.mock("@/components/chat/ChatShell", () => ({ ChatShell: () => null }));

const UNSET = /sign-in isn't set up/i;

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  privy.usePrivy.mockClear();
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

  it("runs the chat page as before: it waits on the Privy session", () => {
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "x".repeat(25));
    render(<ChatPage />);
    expect(privy.usePrivy).toHaveBeenCalled();
    expect(screen.getByText("getting your workspace ready")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: UNSET })).toBeNull();
  });
});
