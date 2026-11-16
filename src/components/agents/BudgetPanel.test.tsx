import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BudgetDTO } from "@/lib/types";
import { BudgetPanel } from "./BudgetPanel";

// The renter's model budget: this week against the budget, within the
// ceiling, back to the maker's default.

beforeEach(() => vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const budget: BudgetDTO = { spentThisWeek: "620000", spentToday: "90000", budget: "1000000", makerDefault: "1000000", ceiling: "5000000", free: false, allowance: "250000", modelShare: true, decimals: 6 };

describe("the budget panel", () => {
  it("shows the week against the budget and saves a new one in minor units", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<BudgetPanel budget={budget} save={save} />);
    expect(screen.getByRole("img", { name: "0.62 USDC of 1.00 USDC spent this week" })).toBeInTheDocument();
    expect(screen.getByText(/Each job's model cost is added to what you pay for it\./)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Weekly budget, in USDC"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the budget" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("2500000"));
    fireEvent.click(screen.getByRole("button", { name: "Use the maker's default" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(null));
  });

  it("refuses more than the ceiling, and says a free agent's allowance", async () => {
    const save = vi.fn();
    render(<BudgetPanel budget={{ ...budget, free: true, modelShare: false }} save={save} />);
    expect(screen.getByText(/boardofserv pays up to 0\.25 USDC a week of it; before a call would go past that, it stops with its work saved and pauses until Monday\./)).toBeInTheDocument();
    // The owner's own SERV key lifts it, added on Connections.
    expect(screen.getByRole("link", { name: "add it on Connections" })).toHaveAttribute("href", "/app/connections#serv-key");
    fireEvent.change(screen.getByLabelText("Weekly budget, in USDC"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the budget" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Write a budget from 0 to 5.00 USDC a week.");
    expect(save).not.toHaveBeenCalled();
  });

  it("says the owner's own SERV key lifts the free allowance, even under a budget within it", () => {
    render(<BudgetPanel budget={{ ...budget, budget: "200000", free: true, modelShare: false }} save={vi.fn()} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText((_, el) => el?.tagName === "P" && /pauses until Monday\. Your own SERV key lifts that: add it on Connections\.$/.test(el.textContent ?? ""))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "add it on Connections" })).toHaveAttribute("href", "/app/connections#serv-key");
  });

  it("says which weekly cap applies, and why, when it isn't the budget the owner set", () => {
    const set = { ...budget, budget: "2000000", spentThisWeek: "244000", free: true, modelShare: false };
    const { rerender } = render(<BudgetPanel budget={set} save={vi.fn()} />);
    expect(screen.getByRole("img", { name: "0.244 USDC of 0.25 USDC spent this week" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("This week's cap is 0.25 USDC, not the 2.00 USDC you set: it runs free, so boardofserv pays for its model calls, up to 0.25 USDC a week. Your own SERV key lifts that cap, and your 2.00 USDC applies: add it on Connections.");
    // Said once, with its link to where the key goes.
    expect(screen.getAllByRole("link", { name: "add it on Connections" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "add it on Connections" })).toHaveAttribute("href", "/app/connections#serv-key");
    // On the owner's own SERV key, their budget is the cap.
    rerender(<BudgetPanel budget={{ ...set, ownKey: true }} save={vi.fn()} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("link", { name: "add it on Connections" })).toBeNull();
    expect(screen.getByRole("img", { name: "0.244 USDC of 2.00 USDC spent this week" })).toBeInTheDocument();
  });
});
