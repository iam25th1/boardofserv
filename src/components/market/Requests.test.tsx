import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEMO_REQUEST, DEMO_REQUESTS } from "@/app/demo/demoRequests";
import type { RentalDTO } from "@/lib/types";
import { RequestsView, type RequestsApi } from "./RequestsView";
import { RequestPageView, type RequestPageApi } from "./RequestPageView";

// The request board and a request's page: asking, "me too", sorting,
// offering, and accepting an offer after being told what renting does.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/app/requests" }));
afterEach(cleanup);

describe("the request board", () => {
  it("lists requests with their tally, sorts them, and says me too", async () => {
    const load = vi.fn(async () => DEMO_REQUESTS);
    const meToo = vi.fn(async () => undefined);
    render(<RequestsView api={{ load, meToo, ask: vi.fn() }} />);
    const cards = await screen.findAllByRole("article");
    expect(cards.map((c) => within(c).getByRole("link").textContent)).toEqual(DEMO_REQUESTS.map((r) => r.need));
    expect(cards[0]).toHaveTextContent("12 want it too");
    expect(cards[0]).toHaveTextContent("up to 8.00 USDC a week");
    expect(within(cards[0]!).getByRole("button", { name: "Me too" })).toHaveAttribute("aria-pressed", "true");
    // One's own request has no me too button.
    expect(within(cards[2]!).queryByRole("button", { name: "Me too" })).toBeNull();
    fireEvent.click(within(cards[1]!).getByRole("button", { name: "Me too" }));
    await waitFor(() => expect(meToo).toHaveBeenCalledWith("q-2", true));
    fireEvent.click(screen.getByLabelText("Newest"));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith("newest"));
  });

  it("asks for an agent with what it connects to and a budget", async () => {
    const ask = vi.fn(async () => ({ id: "q-9" }));
    const onAsked = vi.fn();
    render(<RequestsView api={{ load: async () => [], ask, onAsked }} />);
    expect(await screen.findByText(/No requests yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("What should it do?"), { target: { value: "Count new sign-ups each Monday" } });
    fireEvent.click(screen.getByLabelText("Google Sheets"));
    fireEvent.change(screen.getByLabelText("You'd pay up to, a week, in USDC"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Post the request" }));
    await waitFor(() => expect(ask).toHaveBeenCalledWith({ need: "Count new sign-ups each Monday", detail: "", connects: ["sheets"], budget: "4" }));
    expect(onAsked).toHaveBeenCalledWith("q-9");
  });

  it("sends someone signed out to sign in", async () => {
    render(<RequestsView api={{ load: async () => DEMO_REQUESTS, signIn: "/login?next=%2Fapp%2Frequests" }} />);
    expect(await screen.findByRole("link", { name: "Sign in to ask" })).toHaveAttribute("href", "/login?next=%2Fapp%2Frequests");
    expect(screen.getAllByRole("link", { name: "Sign in to say me too" }).length).toBeGreaterThan(0);
  });
});

describe("a request's page", () => {
  it("lets the one who asked accept an offer after saying what renting does", async () => {
    const rental = { id: "r-7" } as RentalDTO;
    const accept = vi.fn(async () => rental);
    const onRented = vi.fn();
    const api: RequestPageApi = { load: async () => DEMO_REQUEST, accept, onRented, close: async () => DEMO_REQUEST };
    render(<RequestPageView id="q-1" api={api} />);
    const offers = await screen.findAllByRole("article");
    expect(offers[0]).toHaveTextContent("Point it at your invoices tab");
    expect(within(offers[0]!).getByRole("link", { name: "Enquiry follow-up" })).toHaveAttribute("href", "/app/board/agents/00000000-0000-4000-8000-000000000003");
    // Not listed: no page on the board to link to.
    expect(within(offers[1]!).queryByRole("link", { name: "Invoice nudge" })).toBeNull();
    fireEvent.click(within(offers[1]!).getByRole("button", { name: "Accept and rent it" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("The first week, 7.50 USDC, comes out of your wallet balance now.");
    expect(dialog).toHaveTextContent("Each job it finishes costs 0.10 USDC");
    expect(accept).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Pay 7.50 USDC and rent it" }));
    await waitFor(() => expect(onRented).toHaveBeenCalledWith(rental));
    expect(accept).toHaveBeenCalledWith("o-2");
    expect(screen.getByRole("button", { name: "Close the request" })).toBeInTheDocument();
  });

  it("lets a maker offer one of their published agents with a note and a price", async () => {
    const page = { ...DEMO_REQUEST, request: { ...DEMO_REQUEST.request, mine: false } };
    const offer = vi.fn(async () => page);
    const api: RequestPageApi = { load: async () => page, myAgents: async () => [{ id: "a-9", name: "Invoice helper", version: 3 }], offer, meToo: async () => page };
    render(<RequestPageView id="q-1" api={api} />);
    expect(await screen.findByRole("heading", { name: "Offer one of your agents" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Invoice helper, version 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept and rent it" })).toBeNull();
    fireEvent.change(screen.getByLabelText("A note to them (optional)"), { target: { value: "Does both reminders." } });
    fireEvent.change(screen.getByLabelText("A week, in USDC"), { target: { value: "5.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Offer it" }));
    await waitFor(() => expect(offer).toHaveBeenCalledWith({ agentId: "a-9", note: "Does both reminders.", weeklyPrice: "5500000", jobFee: "0" }));
  });
});
