import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SafetyDTO } from "@/lib/types";
import { SafetyPanel } from "./SafetyPanel";

// The renter's panel: tools by risk level, the floor said plainly, a
// switch for what can be raised and the auto spend limit.

afterEach(cleanup);

const safety: SafetyDTO = {
  tools: [
    { tool: "sheets.read", risk: "read", does: "Read every row of a sheet.", floor: null, asks: false, canRaise: false },
    { tool: "memory.set", risk: "write", does: "Remember a value for this renter, for the next job.", floor: null, asks: false, canRaise: true },
    { tool: "telegram.send", risk: "outbound", does: "Send the owner a message.", floor: null, asks: true, canRaise: true },
    { tool: "sheets.write", risk: "money", does: "Add rows to a sheet, or replace all of its rows.", floor: "Asks you before spending more than your auto limit, or than its trust score allows.", asks: false, canRaise: false },
  ],
  autoSpendUsdc: 0,
  maxAutoSpendUsdc: 1000,
};

describe("the safety panel", () => {
  it("groups tools by level, says the floor, and saves what the renter raised", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<SafetyPanel safety={safety} save={save} />);
    const levels = screen.getAllByRole("listitem").filter((li) => li.parentElement?.tagName === "OL");
    expect(levels.map((l) => l.querySelector("strong")!.textContent)).toEqual(["Looks things up", "Changes your own data", "Sends a message", "Spends money"]);
    expect(within(levels[0]!).getByText("on its own")).toBeInTheDocument();
    expect(within(levels[3]!).getByText("Asks you before spending more than your auto limit, or than its trust score allows.")).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox", { name: "Ask me first" });
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0]!);
    fireEvent.change(screen.getByLabelText("Spend without asking, per payment or order, in USDC"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ askFor: ["telegram.send", "memory.set"], autoSpendUsdc: 20 }));
  });

  it("refuses an auto limit out of bounds without saving", async () => {
    const save = vi.fn();
    render(<SafetyPanel safety={safety} save={save} />);
    fireEvent.change(screen.getByLabelText("Spend without asking, per payment or order, in USDC"), { target: { value: "-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Write an auto limit from 0 to 1000 USDC.");
    expect(save).not.toHaveBeenCalled();
  });
});
