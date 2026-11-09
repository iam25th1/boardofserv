import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DEMO_DASHBOARD, DEMO_RUNS } from "@/app/demo/demoRentals";
import type { MakerDashboardDTO } from "@/lib/types";
import { MakerDashboard } from "./MakerDashboard";

// The maker's dashboard: earnings by week (with a table and a hover per
// week), renters by handle, failures by step, versions and runs.

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (d: MakerDashboardDTO = DEMO_DASHBOARD) => render(<MakerDashboard id={d.agentId} api={{ load: async () => d, runs: async () => DEMO_RUNS }} />);

describe("the maker's dashboard", () => {
  it("shows what it earned, week by week, with every week's amount in a table and on hover", async () => {
    show();
    expect(await screen.findByText("142.99 USDC")).toBeInTheDocument();
    expect(screen.getByText("96% (212 of 221)")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Earned each week" });
    expect(within(table).getAllByRole("row")).toHaveLength(9);
    expect(table).toHaveTextContent("26.10 USDC");
    const latest = screen.getByRole("button", { name: /^Week of Nov 9: 26\.10 USDC$/ });
    fireEvent.focus(latest);
    expect(latest).toHaveTextContent("week of Nov 9");
  });

  it("lists renters by handle, failures by step, versions, and how to change the price", async () => {
    show();
    const renters = await screen.findByRole("region", { name: "Who rents it" });
    expect(within(renters).getAllByRole("listitem").map((li) => li.querySelector("strong")!.textContent)).toEqual(["@jordan_lee", "@ari.studio", "@kofi_m", "@pat_designs", "@rowan_t"]);
    const fails = screen.getByRole("region", { name: "Where renters' jobs failed" });
    expect(within(fails).getAllByRole("listitem")[0]).toHaveTextContent("Read new enquiries6 jobs");
    expect(screen.getByText("1 running it, offered to 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change the price in its builder" })).toHaveAttribute("href", `/app/agents/${DEMO_DASHBOARD.agentId}`);
    expect(await screen.findByRole("region", { name: "How it runs for real" })).toBeInTheDocument();
  });

  it("says plainly when nothing has happened yet", async () => {
    show({ ...DEMO_DASHBOARD, renters: [], failures: [], jobs: { done: 0, failed: 0 }, earnedTotal: "0", earnings: DEMO_DASHBOARD.earnings.map((w) => ({ ...w, amount: "0" })) });
    expect(await screen.findByText(/Nobody yet\. It's on the board: renters find it there\./)).toBeInTheDocument();
    expect(screen.getByText("none ran yet")).toBeInTheDocument();
    expect(screen.getByText("No failed jobs in the last 30 days.")).toBeInTheDocument();
  });
});
