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
    expect(screen.getByText(/boardofserv pays up to 0\.25 USDC a week of it; after that it pauses until Monday\./)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Weekly budget, in USDC"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the budget" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Write a budget from 0 to 5.00 USDC a week.");
    expect(save).not.toHaveBeenCalled();
  });
});
