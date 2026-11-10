import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Landing } from "@/components/landing/Landing";
import AboutPage from "@/app/about/page";
import TermsPage from "@/app/terms/page";
import PrivacyPage from "@/app/privacy/page";
import SupportPage from "@/app/support/page";
import { BANDS, TRUST } from "@/lib/trust/config";
import { readPaymentsConfig } from "@/lib/payments/config";
import { SCOPES } from "@/lib/google/oauth";

// What the public pages say is kept true by the code they describe: the
// trust score's range, the network and its test money, what Google is
// asked for, and that every page loads for someone signed out (no
// sign-in provider at all here).

vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the public pages' claims", () => {
  it("give the trust score's real range, and say the lowest band always asks", () => {
    const { container } = render(<Landing />);
    expect(container.textContent).toContain(`a score from ${TRUST.MIN} to ${TRUST.MAX}`);
    expect(BANDS[0]).toMatchObject({ from: TRUST.MIN, perPayment: 0 });
    expect(container.textContent).toContain("The lower it is, the less it may pay without asking.");
  });

  it("name the network the payments run on, with its test money", () => {
    const network = readPaymentsConfig({ TREASURY_ADDRESS: "0x000000000000000000000000000000000000dEaD" });
    expect(network.mainnet).toBe(false);
    for (const Page of [Landing, AboutPage, TermsPage]) {
      const { container } = render(<Page />);
      expect(container.textContent).toContain(`test USDC on ${network.networkLabel}`);
      cleanup();
    }
  });

  it("say what Google is asked for, and nothing more is asked", () => {
    expect(SCOPES).toEqual(["openid", "email", "https://www.googleapis.com/auth/spreadsheets"]);
    render(<PrivacyPage />);
    const main = screen.getByRole("main");
    expect(main).toHaveTextContent("reads your Google account's email address to show which account is connected");
    expect(main).toHaveTextContent("a sheet's title, tab names and the cells of the tabs you chose");
  });

  it("load for someone signed out, each with its heading and the way to support", () => {
    for (const Page of [Landing, AboutPage, TermsPage, PrivacyPage, SupportPage]) {
      render(<Page />);
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.getAllByRole("link", { name: "Support" })[0]).toHaveAttribute("href", "/support");
      cleanup();
    }
  });
});
