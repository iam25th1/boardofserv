import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReportButton } from "./ReportButton";

// Reporting: signed out it is a link to sign in; signed in, a reason from
// the list and a note, and what came back said plainly.

afterEach(cleanup);

describe("the report button", () => {
  it("sends a reason and a note", async () => {
    const send = vi.fn(async () => undefined);
    render(<ReportButton kind="offer" targetId="o-1" send={send} />);
    fireEvent.click(screen.getByRole("button", { name: "Report this offer" }));
    fireEvent.click(screen.getByLabelText("Shares someone's personal data"));
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "  It lists a customer's phone number.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send the report" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ kind: "offer", targetId: "o-1", reason: "personal_data", note: "It lists a customer's phone number." }));
    expect(await screen.findByText("Thanks. An admin will look at it.")).toBeInTheDocument();
  });

  it("shows a refusal, and is a sign-in link when signed out", async () => {
    const send = vi.fn(async () => {
      throw new Error("You reported it already. An admin will look.");
    });
    render(<ReportButton kind="agent" targetId="a-1" send={send} />);
    fireEvent.click(screen.getByRole("button", { name: "Report this agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Send the report" }));
    expect(await screen.findByText("You reported it already. An admin will look.")).toBeInTheDocument();
    cleanup();
    render(<ReportButton kind="maker" targetId="a-1" signIn="/login?next=%2Fapp%2Fboard" label="Report @lena_prints" />);
    expect(screen.getByRole("link", { name: "Report @lena_prints" })).toHaveAttribute("href", "/login?next=%2Fapp%2Fboard");
    cleanup();
    const { container } = render(<ReportButton kind="maker" targetId="a-1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
