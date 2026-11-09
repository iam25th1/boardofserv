import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEMO_SAFETY } from "@/app/demo/demoSafety";
import type { AdminSafetyDTO } from "@/lib/types";
import { SafetyAdmin } from "./SafetyAdmin";

// The admin's queue: what the screen held and what people reported, each
// approved, hidden or frozen with a reason for the log.

afterEach(cleanup);

describe("the admin queue", () => {
  it("lists held posts and reports, and works each with a reason", async () => {
    const after: AdminSafetyDTO = { ...DEMO_SAFETY, queue: { ...DEMO_SAFETY.queue, held: DEMO_SAFETY.queue.held.slice(1) } };
    const moderate = vi.fn(async () => after);
    render(<SafetyAdmin api={{ load: async () => DEMO_SAFETY, moderate }} />);
    const queue = (await screen.findByRole("heading", { name: "Queue" })).closest("section")!;
    const items = within(queue).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("held request");
    expect(items[0]).toHaveTextContent("The screen held it: It asks for a private person's home address.");
    expect(items[2]).toHaveTextContent('A scam or fraud: "It says it doubles USDC deposits overnight."');
    // A maker is frozen or let be: there is nothing of theirs to hide.
    expect(within(items[3]!).queryByRole("button", { name: "Hide" })).toBeNull();
    // No reason, no decision.
    const hide = within(items[0]!).getByRole("button", { name: "Hide" });
    expect(hide).toBeDisabled();
    fireEvent.change(within(items[0]!).getByLabelText("Why"), { target: { value: "Personal data." } });
    fireEvent.click(hide);
    await waitFor(() => expect(moderate).toHaveBeenCalledWith({ type: "request", id: "q-held", action: "hide", reason: "Personal data." }));
    await waitFor(() => expect(within(queue).getAllByRole("listitem")).toHaveLength(3));
  });

  it("says when the queue is empty, and shows a refusal", async () => {
    const empty: AdminSafetyDTO = { ...DEMO_SAFETY, queue: { reports: [], held: [] } };
    render(<SafetyAdmin api={{ load: async () => empty }} />);
    expect(await screen.findByText(/Nothing waiting/)).toBeInTheDocument();
    cleanup();
    const moderate = vi.fn(async () => {
      throw new Error("It isn't waiting in the queue.");
    });
    render(<SafetyAdmin api={{ load: async () => DEMO_SAFETY, moderate }} />);
    const first = (await screen.findAllByRole("listitem"))[0]!;
    fireEvent.change(within(first).getByLabelText("Why"), { target: { value: "Looks fine." } });
    fireEvent.click(within(first).getByRole("button", { name: "Approve" }));
    expect(await within(first).findByRole("alert")).toHaveTextContent("It isn't waiting in the queue.");
  });
});
