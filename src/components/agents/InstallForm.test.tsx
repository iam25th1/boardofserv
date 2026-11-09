import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { checkDefinition } from "@/lib/agents/definition";
import { wireToDefinition } from "@/lib/agents/plan";
import type { InstallAnswers } from "@/lib/agents/settingsForm";
import { RESTOCK_WIRE } from "@/test/agentFixtures";
import { InstallForm } from "./InstallForm";

// Running an agent for real: a field per settings question, the rules with
// the maker's defaults, when it runs, and the answers checked before they go.

const d = (() => {
  const c = checkDefinition(wireToDefinition(RESTOCK_WIRE));
  if (!c.ok) throw new Error("fixture");
  return c.definition;
})();

afterEach(cleanup);

describe("the install form", () => {
  it("asks each settings question, fills the rules with the maker's defaults, and sends the answers", async () => {
    const sent: InstallAnswers[] = [];
    render(<InstallForm definition={d} defaults={{ stock_sheet: "Stock", orders_sheet: "Orders" }} onInstall={async (a) => void sent.push(a)} />);
    expect(screen.getByLabelText(/Which sheet holds your stock\?/)).toHaveValue("Stock");
    expect(screen.getByLabelText(/Ask me before orders over/)).toHaveValue("250");
    expect(screen.getByText(/The maker's default is 250/)).toBeInTheDocument();
    expect(screen.getByLabelText("At")).toHaveValue("08:00");
    fireEvent.click(screen.getByRole("button", { name: "Start it" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ settings: { stock_sheet: "Stock", orders_sheet: "Orders" }, rules: { approval_over_usdc: "250", max_delivery_days: "7" }, schedule: { at: "08:00", day: null }, minGapMinutes: 5, dailySpendUsd: 0.5 });
  });

  it("says what needs another look before sending anything", async () => {
    const sent: InstallAnswers[] = [];
    render(<InstallForm definition={d} defaults={{}} onInstall={async (a) => void sent.push(a)} />);
    fireEvent.change(screen.getByLabelText(/Ask me before orders over/), { target: { value: "lots" } });
    fireEvent.click(screen.getByRole("button", { name: "Start it" }));
    expect(await screen.findByText("Some answers need another look.")).toBeInTheDocument();
    expect(screen.getAllByText("Give the sheet's name.")).toHaveLength(2);
    expect(screen.getByText("Give an amount in USDC.")).toBeInTheDocument();
    expect(sent).toEqual([]);
  });
});
