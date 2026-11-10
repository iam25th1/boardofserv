import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEMO_SPENDING, demoSpendingApi } from "@/app/demo/demoSpending";
import { SpendingPanel, type SpendingApi } from "./SpendingPanel";

// The renter's spending panel: the allowance and its top up, what it may
// pay without asking and why, payees, receipts with their transfers, and
// disputes that say plainly a payment can't be pulled back.

afterEach(cleanup);

const panel = async (api: SpendingApi = demoSpendingApi()) => {
  render(<SpendingPanel api={api} />);
  return (await screen.findByRole("heading", { name: "Spending" })).closest("section")!;
};

describe("the spending panel", () => {
  it("shows the allowance, and what it may pay without asking and why", async () => {
    const p = await panel();
    expect(p).toHaveTextContent("18.75 USDC");
    expect(p).toHaveTextContent("and 1.25 USDC held for a payment on its way");
    expect(within(p).getByRole("img", { name: "20.00 USDC of the most it may hold, 100.00 USDC" })).toBeInTheDocument();
    expect(p).toHaveTextContent("up to 5.00 USDC a payment, 20.00 USDC a day");
    expect(p).toHaveTextContent(`You allow 50.00 USDC a payment, but with its trust score of ${DEMO_SPENDING.limit.trust.score} (fair) it may pay at most 5.00 USDC a payment`);
    expect(p).toHaveTextContent("It has paid 13.25 USDC today.");
    expect(p).toHaveTextContent("Payments on Base can't be pulled back once they're sent.");
  });

  it("says its amounts are test USDC on Base Sepolia", async () => {
    const p = await panel();
    expect(p).toHaveTextContent("Amounts here are test USDC on Base Sepolia, worth nothing while boardofserv is a beta.");
    expect(p).toHaveTextContent("18.75 USDC test, on Base Sepolia");
  });

  it("warns plainly on a payee whose address is high risk, whatever its name", async () => {
    const p = await panel();
    const note = within(p).getByRole("note");
    expect(note).toHaveTextContent("Careful: This address is a wallet of the agent's own maker");
    expect(note).toHaveTextContent("A payment to this address always asks you first, whatever your limits.");
  });

  it("says plainly when it can't pay at all, or payments are paused", async () => {
    const api = { ...demoSpendingApi(), load: async () => ({ ...DEMO_SPENDING, paused: "Checking the treasury.", limit: { ...DEMO_SPENDING.limit, perPayment: "0", stopped: "boardofserv paused this: Checking its payments." } }) };
    const p = await panel(api);
    expect(p).toHaveTextContent("Agent payments are paused on boardofserv for now: Checking the treasury.");
    expect(p).toHaveTextContent("boardofserv paused this: Checking its payments. It can't pay anything now.");
    expect(p).toHaveTextContent("It asks before every payment");
  });

  it("tops up with a fresh key each time, and shows a refusal", async () => {
    const base = demoSpendingApi();
    const allowance = vi.fn(base.allowance);
    const p = await panel({ ...base, allowance });
    fireEvent.click(within(p).getByRole("button", { name: "Top up" }));
    expect(await within(p).findByRole("alert")).toHaveTextContent("Write an amount in USDC first.");
    fireEvent.change(within(p).getByLabelText("Amount in USDC"), { target: { value: "5" } });
    fireEvent.click(within(p).getByRole("button", { name: "Top up" }));
    await waitFor(() => expect(p).toHaveTextContent("23.75 USDC"));
    fireEvent.change(within(p).getByLabelText("Amount in USDC"), { target: { value: "5" } });
    fireEvent.click(within(p).getByRole("button", { name: "Top up" }));
    await waitFor(() => expect(allowance).toHaveBeenCalledTimes(2));
    const [a, b] = allowance.mock.calls.map((c) => c[0].key);
    expect(a).not.toBe(b);
    cleanup();
    const refused = await panel({ ...base, allowance: async () => Promise.reject(new Error("Your balance has 2.00 USDC, which doesn't cover 5.00 USDC.")) });
    fireEvent.change(within(refused).getByLabelText("Amount in USDC"), { target: { value: "5" } });
    fireEvent.click(within(refused).getByRole("button", { name: "Top up" }));
    expect(await within(refused).findByRole("alert")).toHaveTextContent("doesn't cover");
  });

  it("lists payees, saves one, and names a suggestion only when the renter does", async () => {
    const base = demoSpendingApi();
    const payees = vi.fn(base.payees);
    const p = await panel({ ...base, payees });
    expect(p).toHaveTextContent("Loom & Co");
    expect(p).toHaveTextContent("not paid yet: its first payment asks you");
    expect(p).toHaveTextContent("It tried to pay an address you haven't saved. Nothing was paid.");
    const save = within(p).getByRole("button", { name: "Save it" });
    expect(save).toBeDisabled();
    fireEvent.change(within(p).getByLabelText("A name for 0x4B1D...93Ac"), { target: { value: "Dye house" } });
    fireEvent.click(save);
    await waitFor(() => expect(payees).toHaveBeenCalledWith({ action: "confirm", payeeId: "p-3", label: "Dye house" }));
    fireEvent.change(within(p).getByLabelText("Name"), { target: { value: "Spool" } });
    fireEvent.change(within(p).getByLabelText("Base address"), { target: { value: "0x00000000000000000000000000000000000000aa" } });
    fireEvent.click(within(p).getByRole("button", { name: "Save the payee" }));
    await waitFor(() => expect(payees).toHaveBeenCalledWith({ action: "save", label: "Spool", address: "0x00000000000000000000000000000000000000aa" }));
  });

  it("shows each receipt with its transfer, the check and who approved it", async () => {
    const p = await panel();
    const receipts = within(within(p).getByRole("heading", { name: "Receipts" }).parentElement!).getAllByRole("listitem");
    expect(receipts).toHaveLength(4);
    expect(receipts[1]).toHaveTextContent("12.00 USDC");
    expect(receipts[1]).toHaveTextContent("paid");
    expect(receipts[1]).toHaveTextContent("Safety checkasked you: Twice its usual order.");
    expect(within(receipts[1]!).getByRole("link", { name: "The transfer on Base Sepolia" })).toHaveAttribute("href", expect.stringMatching(/^https:\/\/sepolia\.basescan\.org\/tx\/0x/));
    expect(receipts[3]).toHaveTextContent("failed, nothing paid");
    expect(receipts[3]).toHaveTextContent("went back to its allowance");
    expect(within(receipts[3]!).queryByRole("link")).toBeNull();
    // Only a payment that went through, inside the window, can be disputed.
    expect(within(receipts[1]!).getByRole("button", { name: "Dispute it" })).toBeInTheDocument();
    expect(within(receipts[3]!).queryByRole("button", { name: "Dispute it" })).toBeNull();
  });

  it("disputes a payment, saying first that it can't be pulled back", async () => {
    const base = demoSpendingApi();
    const dispute = vi.fn(base.dispute);
    const p = await panel({ ...base, dispute });
    expect(p).toHaveTextContent("Upheld: It paid an order the shop had already paid.");
    const receipts = within(within(p).getByRole("heading", { name: "Receipts" }).parentElement!).getAllByRole("listitem");
    fireEvent.click(within(receipts[1]!).getByRole("button", { name: "Dispute it" }));
    const form = (await within(p).findByText("Dispute 12.00 USDC to Weftworks")).closest("form")!;
    expect(form).toHaveTextContent("A payment on Base can't be pulled back once it is sent. If your dispute is upheld, it counts against the agent's trust score, but the money stays with the payee.");
    const send = within(form).getByRole("button", { name: "Send the dispute" });
    fireEvent.change(within(form).getByLabelText("Say what happened"), { target: { value: "short" } });
    expect(send).toBeDisabled();
    fireEvent.click(within(form).getByLabelText("It paid the wrong amount"));
    fireEvent.change(within(form).getByLabelText("Say what happened"), { target: { value: "It paid for 20 m, only 12 m came." } });
    fireEvent.click(send);
    await waitFor(() => expect(dispute).toHaveBeenCalledWith({ kind: "payment", id: "r-3", reason: "wrong_amount", note: "It paid for 20 m, only 12 m came." }));
    await waitFor(() => expect(p).toHaveTextContent("waiting for an admin"));
  });

  it("disputes a week's rent, which is refunded if upheld", async () => {
    const p = await panel();
    fireEvent.click(within(p).getByRole("button", { name: "Dispute this week" }));
    const form = (await within(p).findByText("Dispute Rent for week 3, paid 2026-11-03")).closest("form")!;
    expect(form).toHaveTextContent("If your dispute is upheld, the week's rent comes back to your balance.");
    expect(within(form).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["not_working", "other"]);
  });
});
