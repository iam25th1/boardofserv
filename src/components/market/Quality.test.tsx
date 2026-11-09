import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEMO_AGENTS } from "@/app/demo/DemoMarket";
import { DEMO_DASHBOARD } from "@/app/demo/demoRentals";
import { BoardView } from "./BoardView";
import { QualityPanel, ScoredJobs, qualityLine } from "./Quality";

// Quality on the board, an agent page and the maker's dashboard: a score
// once enough jobs were reviewed, otherwise "not enough reviewed jobs yet";
// the routes, the last version as history; sorting and filtering by it.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/app/board" }));
afterEach(cleanup);

describe("quality", () => {
  it("is a line for a card: a score from so many jobs, or not enough yet", () => {
    expect(qualityLine(DEMO_AGENTS[0]!.quality)).toBe("88 out of 100, from 24 reviewed jobs");
    expect(qualityLine(DEMO_AGENTS[2]!.quality)).toBe("not enough reviewed jobs yet (2 of 5)");
    expect(qualityLine(DEMO_AGENTS[3]!.quality)).toBe("not enough reviewed jobs yet");
  });

  it("shows its score, routes and the version before on a panel", () => {
    render(<QualityPanel q={DEMO_AGENTS[0]!.quality} />);
    expect(screen.getByText("88")).toBeInTheDocument();
    expect(screen.getByText("out of 100, from 24 reviewed jobs")).toBeInTheDocument();
    const routes = screen.getAllByRole("listitem").map((l) => l.textContent);
    expect(routes).toEqual(["good to use83%", "needs a look13%", "advised against4%"]);
    expect(screen.getByText("Version 2 scored 81 from 30 reviewed jobs.")).toBeInTheDocument();
    cleanup();
    render(<QualityPanel q={DEMO_AGENTS[3]!.quality} />);
    expect(screen.getByText("not enough reviewed jobs yet")).toBeInTheDocument();
  });

  it("lists the maker's scored jobs with score, route, reason and rubric", () => {
    render(<ScoredJobs jobs={DEMO_DASHBOARD.scored} />);
    const items = within(screen.getByRole("list", { name: "" }).closest("ol")!).getAllByRole("listitem").filter((l) => l.parentElement?.tagName === "OL");
    expect(items).toHaveLength(3);
    expect(items[2]).toHaveTextContent("38");
    expect(items[2]).toHaveTextContent("advised against");
    expect(items[2]).toHaveTextContent("without the person's yes");
    expect(within(items[2]!).getByRole("list", { name: "Rubric scores" })).toHaveTextContent("safety 30");
    cleanup();
    render(<ScoredJobs jobs={[]} />);
    expect(screen.getByText(/None yet/)).toBeInTheDocument();
  });

  it("sorts and filters the board by it", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    const load = vi.fn(async () => ({ helpers: [], agents: DEMO_AGENTS }));
    render(<BoardView load={load} />);
    expect(await screen.findByText("Quality 88 out of 100, from 24 reviewed jobs")).toBeInTheDocument();
    expect(screen.getByText("not enough reviewed jobs yet (2 of 5)")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Best quality"));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "quality" }), expect.anything()));
    fireEvent.click(screen.getByLabelText("80 and up"));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ minQuality: "80" }), expect.anything()));
    vi.unstubAllGlobals();
  });
});
