import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { TRUST_FAIR, TRUST_NEW, TRUST_STRONG, trend } from "@/app/demo/demoTrust";
import { bandWords, TrustPanel, trustLine } from "./Trust";

// A trust score shown: a line for a card, a panel with its factors (the
// top few on an agent page, all for its maker), what it lets an agent pay
// without asking, and its trend.

afterEach(cleanup);

describe("a trust score", () => {
  it("is a line for a card, and says what it lets an agent pay", () => {
    expect(trustLine(TRUST_STRONG)).toBe(`Trust ${TRUST_STRONG.score}, ${TRUST_STRONG.label}`);
    expect(bandWords(TRUST_FAIR)).toBe("It may pay up to 5 USDC a payment and 20 USDC a day without asking.");
    expect(bandWords({ band: { label: "low", perPayment: 0, perDay: 0 } })).toBe("It asks before every payment.");
  });

  it("shows its factors with their points, the top few when asked", () => {
    render(<TrustPanel t={TRUST_STRONG} top={3} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(`+${TRUST_STRONG.factors[0]!.points}${TRUST_STRONG.factors[0]!.words}`);
    cleanup();
    render(<TrustPanel t={TRUST_FAIR} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(TRUST_FAIR.factors.length);
    expect(screen.getAllByText(/^-\d+$/).length).toBeGreaterThan(0);
  });

  it("says a new agent earns nothing yet, and which points wait", () => {
    render(<TrustPanel t={TRUST_NEW} />);
    expect(screen.getByText(/new: not enough jobs yet to earn points, only to lose them/)).toBeInTheDocument();
    expect(screen.getByText(/counts once it isn't new/)).toBeInTheDocument();
  });

  it("shows its trend, with each day's score", () => {
    render(<TrustPanel t={TRUST_FAIR} trend={trend(592, 566, 10)} />);
    const fig = screen.getByRole("img");
    expect(fig.getAttribute("aria-label")).toMatch(/^From \d+ on 2026-10-12 to \d+ on 2026-10-21$/);
    expect(within(fig.parentElement!).getByText(/^Down \d+ since 2026-10-12\.$/)).toBeInTheDocument();
  });
});
