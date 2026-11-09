import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RentalDetailDTO } from "@/lib/types";
import { demoJob, DEMO_NOW, DEMO_RENTAL, DEMO_RENTALS } from "@/app/demo/demoRentals";
import { RentalView, type RentalApi } from "./RentalView";
import { RentalsView } from "./RentalsView";

// The renter's dashboard: where it stands, the money, the questions and
// jobs, and the controls each state allows.

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/app/rentals" }));
beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function api(rental: RentalDetailDTO, patch: Partial<RentalApi> = {}): RentalApi {
  return { load: vi.fn().mockResolvedValue(rental), control: vi.fn().mockResolvedValue(rental), run: vi.fn().mockResolvedValue(undefined), job: vi.fn(async (id: string) => demoJob(id)), answer: vi.fn(), version: vi.fn().mockResolvedValue({ rental, setupAgain: false }), now: () => DEMO_NOW, ...patch };
}
const rental = (patch: Partial<RentalDetailDTO>): RentalDetailDTO => ({ ...DEMO_RENTAL, ...patch });

describe("one rental", () => {
  it("shows its state, the week and the money, its question and its newest job's timeline", async () => {
    const a = api(DEMO_RENTAL);
    render(<RentalView id="r-1" api={a} />);
    expect(await screen.findByRole("heading", { name: "Enquiry follow-up", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("9.75 USDC")).toBeInTheDocument();
    expect(screen.getByText("19.25 USDC")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Week 2: 3 of 7 days gone, renews/ })).toBeInTheDocument();
    const waiting = screen.getByRole("region", { name: "Waiting for you" });
    expect(within(waiting).getByRole("button", { name: "Send it" })).toBeInTheDocument();
    // The job waiting on that question stays shut; the next one opens.
    await waitFor(() => expect(a.job).toHaveBeenCalledWith("j-2"));
    expect(a.job).not.toHaveBeenCalledWith("j-1");
    expect(screen.getByRole("link", { name: "Its settings, rules, memory and messages" })).toHaveAttribute("href", "/app/installations/i-1");
  });

  it("offers a new version: update in place, or set it up again when it's a breaking change", async () => {
    const a = api(DEMO_RENTAL);
    render(<RentalView id="r-1" api={a} />);
    const offer = await screen.findByRole("region", { name: "Version 3 is out" });
    expect(offer).toHaveTextContent("Updating keeps your answers, sheets and connections");
    fireEvent.click(within(offer).getByRole("button", { name: "Stay on version 2" }));
    await waitFor(() => expect(a.version).toHaveBeenCalledWith("stay"));
    cleanup();
    const b = api(rental({ offer: { version: 3, breaking: 'It asks something new at setup ("Notes tab").' } }), { version: vi.fn().mockResolvedValue({ rental: DEMO_RENTAL, setupAgain: true }) });
    render(<RentalView id="r-1" api={b} />);
    const breaking = await screen.findByRole("region", { name: "Version 3 is out" });
    expect(breaking).toHaveTextContent('It asks something new at setup ("Notes tab"). Updating stops what runs now; then you set it up again.');
    fireEvent.click(within(breaking).getByRole("button", { name: "Update and set it up again" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/rentals/r-1/setup"));
  });

  it("cancels to the end of the paid week, after saying so", async () => {
    const a = api(DEMO_RENTAL);
    render(<RentalView id="r-1" api={a} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("the end of the week you paid for, then stops. Nothing more is charged.");
    expect(a.control).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel it" }));
    await waitFor(() => expect(a.control).toHaveBeenCalledWith("cancel"));
  });

  it("asks an unpaid one to be paid, pointing to the wallet", async () => {
    const a = api(rental({ status: "unpaid", weeklyPrice: "12000000", pausedReason: "This week's rent of 12.00 USDC couldn't be paid: your balance is too low." }));
    render(<RentalView id="r-1" api={a} />);
    expect(await screen.findByRole("link", { name: "Top up your wallet" })).toHaveAttribute("href", "/app/wallet");
    fireEvent.click(screen.getByRole("button", { name: "Pay 12.00 USDC and resume" }));
    await waitFor(() => expect(a.control).toHaveBeenCalledWith("resume"));
  });

  it("offers each state's next step: set up, keep renting, rent again", async () => {
    render(<RentalView id="r-1" api={api(rental({ status: "setup", installation: null, installationId: null }))} />);
    expect((await screen.findAllByRole("link", { name: "Set it up" }))[0]).toHaveAttribute("href", "/app/rentals/r-1/setup");
    cleanup();
    const a = api(rental({ status: "cancelling", renews: false }));
    render(<RentalView id="r-1" api={a} />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep renting" }));
    await waitFor(() => expect(a.control).toHaveBeenCalledWith("renew"));
    cleanup();
    render(<RentalView id="r-1" api={api(rental({ status: "ended" }))} />);
    expect(await screen.findByRole("link", { name: "Rent it again" })).toHaveAttribute("href", `/app/board/agents/${DEMO_RENTAL.agentId}`);
  });
});

describe("everything rented", () => {
  it("lists each rental with its state and when it renews, stops or is due", async () => {
    render(<RentalsView load={async () => DEMO_RENTALS} />);
    const cards = await screen.findAllByRole("link");
    expect(cards.map((c) => c.getAttribute("href"))).toEqual(["/app/rentals/r-1", "/app/rentals/r-2", "/app/rentals/r-3", "/app/rentals/r-4"]);
    expect(cards[1]).toHaveTextContent("stops at the week's end");
    expect(cards[2]).toHaveTextContent("Duenow");
    expect(cards[3]).toHaveTextContent("set it up first");
  });

  it("points to the board when nothing is rented", async () => {
    render(<RentalsView load={async () => []} />);
    expect(await screen.findByRole("link", { name: "Find one on the board" })).toHaveAttribute("href", "/app/board");
  });
});
