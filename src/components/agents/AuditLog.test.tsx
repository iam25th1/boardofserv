import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEMO_AUDIT } from "@/app/demo/demoSafety";
import type { AuditPageDTO } from "@/lib/types";
import { AuditLog } from "./AuditLog";

// The audit log: what ran, SERV's check and why, who approved it and its
// cost, newest first, a page at a time; the maker's view says only what
// isn't the renter's.

afterEach(cleanup);

describe("the audit log", () => {
  it("shows each guarded action with SERV's check, who approved it and its cost", async () => {
    render(<AuditLog view="renter" load={async () => ({ entries: DEMO_AUDIT, next: null })} />);
    const items = await screen.findAllByRole("listitem", { name: undefined });
    const first = items.find((i) => i.getAttribute("data-outcome") === "ran")!;
    expect(first).toHaveTextContent("Record the order");
    expect(first).toHaveTextContent('Add 1 row to "Orders"?');
    expect(first).toHaveTextContent("SERV's check let it run: It fits what the agent is for.");
    expect(first).toHaveTextContent("You said yes");
    expect(first).toHaveTextContent("Its check cost 0.001156 USDC");
    const blocked = items.find((i) => i.getAttribute("data-outcome") === "blocked")!;
    expect(blocked).toHaveTextContent("SERV's check blocked it: It sends the shop's orders to a supplier it doesn't use.");
    expect(within(blocked).getByText("Blocked")).toBeInTheDocument();
  });

  it("pages to older lines, and says when there are none", async () => {
    const load = vi.fn(async (before?: string | null): Promise<AuditPageDTO> => (before ? { entries: DEMO_AUDIT.slice(2), next: null } : { entries: DEMO_AUDIT.slice(0, 2), next: "42" }));
    render(<AuditLog view="renter" load={load} />);
    await screen.findByText("Record the order");
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith("42"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show older" })).toBeNull());
    cleanup();
    render(<AuditLog view="renter" load={async () => ({ entries: [], next: null })} />);
    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
  });

  it("names renters by number for the maker, with nothing of theirs", async () => {
    const hidden = DEMO_AUDIT.map((e, i) => ({ ...e, renter: `Renter ${i + 1}`, what: null, reason: null, guardReason: null, spent: null }));
    render(<AuditLog view="maker" load={async () => ({ entries: hidden, next: null })} />);
    const items = await screen.findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("for Renter 1");
    expect(screen.queryByText(/Orders/)).toBeNull();
    expect(screen.getAllByText(/Its renter said yes|Within its renter's settings/).length).toBeGreaterThan(0);
  });
});
