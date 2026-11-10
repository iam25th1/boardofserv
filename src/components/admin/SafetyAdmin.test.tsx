import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEMO_SAFETY } from "@/app/demo/demoSafety";
import type { AdminSafetyDTO } from "@/lib/types";
import { SafetyAdmin } from "./SafetyAdmin";

// The admin's queue: what the screen held and what people reported, each
// approved, hidden or frozen with a reason for the log.

afterEach(cleanup);

describe("the admin queue", () => {
  it("lists Reppo's blocks, held posts and reports, and works each with a reason", async () => {
    const start: AdminSafetyDTO = { ...DEMO_SAFETY, queue: { ...DEMO_SAFETY.queue, disputes: { open: [], waiting: 0, ledgerReady: true } } };
    const after: AdminSafetyDTO = { ...start, queue: { ...start.queue, held: start.queue.held.filter((h) => h.id !== "q-held") } };
    const moderate = vi.fn(async () => after);
    render(<SafetyAdmin api={{ load: async () => start, moderate }} />);
    const queue = (await screen.findByRole("heading", { name: "Queue" })).closest("section")!;
    const items = within(queue).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(items[0]).toHaveTextContent("job Reppo blocked");
    expect(items[0]).toHaveTextContent("Reppo scored it 38 out of 100 and advised against it: It recorded a reply as ready to send");
    expect(items[1]).toHaveTextContent("held listing");
    expect(items[1]).toHaveTextContent("Reppo's quality checks advised against 3 of its recent jobs");
    expect(items[2]).toHaveTextContent("held request");
    expect(items[2]).toHaveTextContent("The screen held it: It asks for a private person's home address.");
    expect(items[4]).toHaveTextContent('A scam or fraud: "It says it doubles USDC deposits overnight."');
    // A maker is frozen or let be: there is nothing of theirs to hide.
    expect(within(items[5]!).queryByRole("button", { name: "Hide" })).toBeNull();
    // No reason, no decision.
    const hide = within(items[2]!).getByRole("button", { name: "Hide" });
    expect(hide).toBeDisabled();
    fireEvent.change(within(items[2]!).getByLabelText("Why"), { target: { value: "Personal data." } });
    fireEvent.click(hide);
    await waitFor(() => expect(moderate).toHaveBeenCalledWith({ type: "request", id: "q-held", action: "hide", reason: "Personal data." }));
    await waitFor(() => expect(within(queue).getAllByRole("listitem")).toHaveLength(5));
    // A Reppo block is worked the same way.
    fireEvent.change(within(items[0]!).getByLabelText("Why"), { target: { value: "One-off." } });
    fireEvent.click(within(within(queue).getAllByRole("listitem")[0]!).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(moderate).toHaveBeenCalledWith({ type: "reppo", id: "b-1", action: "approve", reason: "One-off." }));
  });

  it("shows renters' disputes, upheld or rejected with a reason, and says what upholding does", async () => {
    const moderate = vi.fn(async () => ({ ...DEMO_SAFETY, queue: { ...DEMO_SAFETY.queue, disputes: { ...DEMO_SAFETY.queue.disputes, open: DEMO_SAFETY.queue.disputes.open.slice(1) } } }));
    render(<SafetyAdmin api={{ load: async () => DEMO_SAFETY, moderate }} />);
    const queue = (await screen.findByRole("heading", { name: "Queue" })).closest("section")!;
    const [pay, rent] = within(queue).getAllByRole("listitem");
    expect(pay).toHaveTextContent("payment dispute");
    expect(pay).toHaveTextContent("Fabric restock: 4.00 USDC to Weftworks on 2026-11-08");
    expect(pay).toHaveTextContent("@harbor_tea against @lena_prints");
    expect(pay).toHaveTextContent("can't be pulled back on Base");
    expect(rent).toHaveTextContent("rent dispute");
    expect(rent).toHaveTextContent("Upheld, 6.00 USDC goes back to the renter");
    expect(within(pay!).queryByRole("button", { name: "Approve" })).toBeNull();
    const uphold = within(pay!).getByRole("button", { name: "Uphold" });
    expect(uphold).toBeDisabled();
    fireEvent.change(within(pay!).getByLabelText("Why"), { target: { value: "It paid the old account." } });
    fireEvent.click(uphold);
    await waitFor(() => expect(moderate).toHaveBeenCalledWith({ type: "dispute", id: "d-1", action: "uphold", reason: "It paid the old account." }));
  });

  it("shows how the models answered this week: empty answers and calls tried again, by purpose", async () => {
    render(<SafetyAdmin api={{ load: async () => DEMO_SAFETY }} />);
    const heading = await screen.findByRole("heading", { name: "How the models answered" });
    // The heading, a note, then its table.
    const table = heading.nextElementSibling!.nextElementSibling as HTMLElement;
    const row = within(table).getByRole("row", { name: /Screening posts and listings/ });
    expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Screening posts and listings", "12", "17", "5 (29% of tries)", "3 (25% of calls)"]);
    expect(within(table).getByRole("row", { name: /Replies in the chat/ })).toHaveTextContent("2 (1% of tries)");
  });

  it("says when upheld refunds wait for the ledger", async () => {
    render(<SafetyAdmin api={{ load: async () => ({ ...DEMO_SAFETY, queue: { ...DEMO_SAFETY.queue, disputes: { open: [], waiting: 2, ledgerReady: false } } }) }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("2 upheld rent disputes wait for a refund: the ledger can't take refunds until the owner runs scripts/sql/ledger-kinds.sql");
  });

  it("says when the queue is empty, and shows a refusal", async () => {
    const empty: AdminSafetyDTO = { ...DEMO_SAFETY, queue: { reports: [], held: [], blocked: [], payments: [], disputes: { open: [], waiting: 0, ledgerReady: true } } };
    render(<SafetyAdmin api={{ load: async () => empty }} />);
    expect(await screen.findByText(/Nothing waiting/)).toBeInTheDocument();
    cleanup();
    const moderate = vi.fn(async () => {
      throw new Error("It isn't waiting in the queue.");
    });
    render(<SafetyAdmin api={{ load: async () => DEMO_SAFETY, moderate }} />);
    const queue = (await screen.findByRole("heading", { name: "Queue" })).closest("section")!;
    const first = within(queue).getAllByRole("listitem")[0]!;
    fireEvent.change(within(first).getByLabelText("Why"), { target: { value: "Looks fine." } });
    fireEvent.click(within(first).getByRole("button", { name: "Uphold" }));
    expect(await within(first).findByRole("alert")).toHaveTextContent("It isn't waiting in the queue.");
  });
});
