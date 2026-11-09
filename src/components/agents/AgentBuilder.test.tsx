import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { checkDefinition } from "@/lib/agents/definition";
import { wireToDefinition } from "@/lib/agents/plan";
import type { BenchData, RunEvent } from "@/lib/agents/types";
import type { AgentBuilderDTO } from "@/lib/types";
import { COMPARE, FIND_LOW, RESTOCK_WIRE, restockBench } from "@/test/agentFixtures";
import { AgentBuilder, type BuilderApi } from "./AgentBuilder";

// The builder with the network replaced: the test plays a run's events.

const definition = (() => {
  const c = checkDefinition(wireToDefinition(RESTOCK_WIRE));
  if (!c.ok) throw new Error("fixture");
  return c.definition;
})();

const data = (o: Partial<AgentBuilderDTO> = {}): AgentBuilderDTO => ({
  agent: { id: "a1", version: 1, state: "draft", buildState: "idle", buildNote: null, steps: [] },
  name: "Fabric restock",
  conversationId: null,
  definition,
  code: {
    find_low: { status: "approved", source: FIND_LOW, rounds: 1, note: null },
    compare: { status: "needs_attention", source: COMPARE, rounds: 3, note: "It ignores delivery time." },
  },
  bench: restockBench(),
  versions: [{ number: 1, state: "draft", createdAt: "2026-11-09T08:00:00.000Z", publishedAt: null }],
  ...o,
});

let emit: ((e: RunEvent) => void) | null = null;
const api = {
  load: vi.fn(async () => data()),
  run: vi.fn((_body: { dryRun: boolean; bench: BenchData }, on: (e: RunEvent) => void) => {
    emit = on;
    return () => {};
  }),
  fix: vi.fn(async () => data().agent),
  saveBench: vi.fn(async () => data()),
  publish: vi.fn(async () => data({ agent: { ...data().agent, state: "published" } })),
} satisfies BuilderApi;

beforeEach(() => {
  emit = null;
  Object.values(api).forEach((f) => f.mockClear());
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the agent builder", () => {
  it("lists the steps, each code step's state and, for its maker, its code", () => {
    render(<AgentBuilder initial={data()} api={api} />);
    expect(screen.getByRole("heading", { name: "Fabric restock" })).toBeInTheDocument();
    expect(screen.getByText("Draft, version 1")).toBeInTheDocument();
    expect(screen.getByText("Code approved")).toBeInTheDocument();
    expect(screen.getByText("Code needs your attention: It ignores delivery time.")).toBeInTheDocument();
    expect(screen.getByText("Over the limit, then Ask the owner")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Show the code" })[0]!);
    expect(screen.getByText(/tools\.sheets\.read\(\{ sheet: input\.settings\.stock_sheet \}\)/)).toBeInTheDocument();
  });

  it("runs the bench with its sample data, and lights each step up as it goes", async () => {
    const { container } = render(<AgentBuilder initial={data()} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    expect(api.run).toHaveBeenCalledWith({ dryRun: true, bench: restockBench() }, expect.any(Function));
    await act(async () => {
      emit!({ type: "start", dryRun: true });
      emit!({ type: "step", stepId: "find_low", input: { settings: { stock_sheet: "Stock" } } });
    });
    expect(container.querySelector('[data-node="find_low"]')!.getAttribute("data-state")).toBe("active");
    expect(screen.getByText("running...")).toBeInTheDocument();
    await act(async () => {
      emit!({ type: "tool", stepId: "find_low", tool: "sheets.read", args: { sheet: "Stock" }, result: { rows: [] }, error: null });
      emit!({ type: "step_done", stepId: "find_low", status: "ok", output: { low: [] }, outcome: null, note: null, ms: 12, costUsd: 0 });
      emit!({ type: "step", stepId: "compare", input: {} });
      emit!({ type: "step_done", stepId: "compare", status: "failed", output: null, outcome: null, note: "Its code isn't approved yet.", ms: 0, costUsd: 0 });
      emit!({ type: "end", status: "failed", reason: '"Compare suppliers" has no approved code yet.', steps: 2, ms: 40, costUsd: 0, memory: {}, sheets: {} });
    });
    expect(container.querySelector('[data-node="find_low"]')!.getAttribute("data-state")).toBe("done");
    expect(container.querySelector('[data-node="compare"]')!.getAttribute("data-state")).toBe("failed");
    expect(screen.getByText("done, 12 ms")).toBeInTheDocument();
    expect(screen.getByText("1 tool call", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent('"Compare suppliers" has no approved code yet. 2 steps, 0.0 s, $0.');
  });

  it("runs live when dry run is off, and won't run sample data that isn't JSON", async () => {
    render(<AgentBuilder initial={data()} api={api} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/Decisions ask SERV, within the run's \$0\.05 limit/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Wallet sample data"), { target: { value: "{ not json" } });
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    expect(api.run).not.toHaveBeenCalled();
    expect(screen.getByText("isn't valid JSON", { exact: false })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Wallet sample data"), { target: { value: '{ "balanceUsdc": 900 }' } });
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    expect(api.run).toHaveBeenCalledWith({ dryRun: false, bench: { ...restockBench(), wallet: { balanceUsdc: 900 } } }, expect.any(Function));
  });

  it("saves the draft, publishes a version, and changes the plan from what the maker says", async () => {
    render(<AgentBuilder initial={data()} api={api} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    expect(api.saveBench).toHaveBeenCalledWith(restockBench());
    expect(screen.getByText("Draft saved.")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    });
    expect(screen.getByText("In testing, version 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish version" })).toBeNull();

    const fixer = screen.getByRole("region", { name: "Fix it by saying what went wrong" });
    fireEvent.change(within(fixer).getByRole("textbox"), { target: { value: "it ignored delivery time" } });
    await act(async () => {
      fireEvent.click(within(fixer).getByRole("button", { name: "Change the plan" }));
    });
    expect(api.fix).toHaveBeenCalledWith("it ignored delivery time");
    expect(within(fixer).getByRole("status")).toHaveTextContent("Only the steps that change are written and reviewed again.");
  });

  it("says there are no steps yet before the first plan", () => {
    render(<AgentBuilder initial={data({ definition: null })} api={api} />);
    expect(screen.getByText(/No steps yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run it" })).toBeNull();
  });
});
