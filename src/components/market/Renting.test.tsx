import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentPageDTO, MakerListingDTO, RentalDTO } from "@/lib/types";
import { DEMO_PAGE } from "@/app/demo/DemoMarket";
import { ListingPanel } from "./ListingPanel";
import { RentBox } from "./RentBox";

// Renting from an agent's page, and its maker's price for the board.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/app/board" }));
afterEach(cleanup);

const page = (patch: Partial<AgentPageDTO> = {}): AgentPageDTO => ({ ...DEMO_PAGE, ...patch });
const rental = { id: "r1" } as RentalDTO;

describe("the rent box", () => {
  it("sends someone signed out to sign in and back", () => {
    render(<RentBox page={page()} signedIn={false} here="/app/board/agents/a1" rent={vi.fn()} onRented={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Sign in to rent it" })).toHaveAttribute("href", "/login?next=%2Fapp%2Fboard%2Fagents%2Fa1");
  });

  it("opens its maker's builder, or the viewer's rental, instead of renting again", () => {
    render(<RentBox page={page({ mine: true })} signedIn here="/" rent={vi.fn()} onRented={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Open it in your builder" })).toHaveAttribute("href", `/app/agents/${DEMO_PAGE.id}`);
    cleanup();
    render(<RentBox page={page({ rentalId: "r9" })} signedIn here="/" rent={vi.fn()} onRented={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Open it" })).toHaveAttribute("href", "/app/rentals/r9");
  });

  it("says what renting does before anything is charged, then rents", async () => {
    const rent = vi.fn().mockResolvedValue(rental);
    const onRented = vi.fn();
    render(<RentBox page={page({ jobFee: "250000" })} signedIn here="/" rent={rent} onRented={onRented} />);
    fireEvent.click(screen.getByRole("button", { name: "Rent it" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("The first week, 12.00 USDC, comes out of your wallet balance now.");
    expect(dialog).toHaveTextContent("Each job it finishes costs 0.25 USDC");
    expect(dialog).toHaveTextContent("Cancel any time: it runs to the end of the week you paid for.");
    expect(rent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pay 12.00 USDC and rent it" }));
    await waitFor(() => expect(onRented).toHaveBeenCalledWith(rental));
  });

  it("points to the wallet when the balance doesn't cover the first week", async () => {
    const rent = vi.fn().mockRejectedValue(Object.assign(new Error("The first week is 12.00 USDC, and your balance doesn't cover it."), { status: 402 }));
    render(<RentBox page={page()} signedIn here="/" rent={rent} onRented={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Rent it" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay 12.00 USDC and rent it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("your balance doesn't cover it");
    expect(screen.getByRole("link", { name: "Top up your wallet" })).toHaveAttribute("href", "/app/wallet");
  });
});

describe("the maker's listing", () => {
  it("sends the price in USDC minor units, empty as free", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<ListingPanel agentId="a1" version={2} listing={null} save={save} />);
    fireEvent.change(screen.getByLabelText("A week, in USDC"), { target: { value: "4.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Put it on the board" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ weeklyPrice: "4500000", jobFee: "0", listed: true }));
    expect(await screen.findByRole("status")).toHaveTextContent("It's on the board.");
  });

  it("refuses a price it can't read, and takes a listed agent off the board", async () => {
    const listing: MakerListingDTO = { weeklyPrice: "3000000", jobFee: "100000", decimals: 6, listed: true, version: 1 };
    const save = vi.fn().mockResolvedValue(undefined);
    render(<ListingPanel agentId="a1" version={1} listing={listing} save={save} />);
    expect(screen.getByLabelText("A week, in USDC")).toHaveValue("3");
    expect(screen.getByLabelText("For each job it finishes (optional), in USDC")).toHaveValue("0.1");
    expect(screen.getByRole("link", { name: "See its page" })).toHaveAttribute("href", "/app/board/agents/a1");
    fireEvent.change(screen.getByLabelText("A week, in USDC"), { target: { value: "four" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the price" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Write a price like 4 or 4.50");
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("A week, in USDC"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Take it off the board" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ weeklyPrice: "3000000", jobFee: "100000", listed: false }));
  });
});
