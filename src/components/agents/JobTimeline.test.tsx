import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApprovalDTO, JobDTO } from "@/lib/types";
import { ApprovalCard } from "./ApprovalCard";
import { JobTimeline } from "./JobTimeline";

// A job drawn step by step: the totals, a mark per step, the owner's view
// of what went in and out, the maker's view without it, and the question to
// answer. With reduced motion nothing is drawn, everything is just there.

const timelines = vi.hoisted(() => ({ count: 0, adds: 0 }));
vi.mock("animejs", async (load) => {
  const real = await load<typeof import("animejs")>();
  const tl = { add: () => (timelines.adds++, tl) };
  return {
    ...real,
    createTimeline: () => {
      timelines.count += 1;
      return tl;
    },
    svg: { ...real.svg, createDrawable: (els: Element[]) => els },
    utils: { ...real.utils, set: () => undefined },
  };
});

function motion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
}

const approval: ApprovalDTO = {
  id: "a1",
  jobId: "j1",
  installationId: "i1",
  agentName: "Fabric restock",
  stepTitle: "Ask the owner",
  kind: "ask",
  reason: null,
  question: "Order 36 metres of linen from Weftworks?",
  options: [
    { label: "Yes", effect: 'It goes on to "Owner said yes?" with "Yes" as your answer.' },
    { label: "No", effect: 'It goes on to "Owner said yes?" with "No" as your answer.' },
  ],
  noAnswer: "After 24 hours with no answer, the job stops.",
  status: "pending",
  answer: null,
  expiresAt: "2026-11-10T08:00:00.000Z",
  createdAt: "2026-11-09T08:00:00.000Z",
};

const job = (o: Partial<JobDTO> = {}): JobDTO => ({
  id: "j1",
  installationId: "i1",
  agentName: "Fabric restock",
  status: "waiting_for_owner",
  reason: null,
  started: "on its schedule",
  trigger: "schedule",
  createdAt: "2026-11-09T08:00:00.000Z",
  finishedAt: null,
  costUsd: 0.00063,
  ms: 2400,
  stepCount: 3,
  mine: true,
  viewer: "owner",
  version: 1,
  untrusted: ["order"],
  plan: [],
  steps: [
    { seq: 1, stepId: "find_low", title: "Find low stock", kind: "code", status: "ok", ms: 20, model: null, costUsd: 0, tools: [{ tool: "sheets.read", failed: false }], input: { settings: { stock_sheet: "Stock" } }, output: { low: [] }, outcome: null, note: null, calls: [] },
    { seq: 2, stepId: "check_total", title: "Big order?", kind: "decision", status: "ok", ms: 1300, model: "claude-haiku-4.5", costUsd: 0.00063, tools: [], outcome: "over", note: "366.6 is over 250." },
    { seq: 3, stepId: "ask_owner", title: "Ask the owner", kind: "action", status: "waiting", ms: 0, model: null, costUsd: 0, tools: [], note: approval.question },
  ],
  approvals: [approval],
  ...o,
});

beforeEach(() => {
  timelines.count = 0;
  timelines.adds = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a job's timeline", () => {
  it("draws its steps in one after another, with the totals on top", () => {
    motion(false);
    render(<JobTimeline initial={job()} api={{ load: async () => job() }} />);
    expect(screen.getByText("waiting for your answer")).toBeInTheDocument();
    expect(screen.getByText("2.4 s")).toBeInTheDocument();
    expect(screen.getByText("$0.00063")).toBeInTheDocument();
    const steps = screen.getAllByRole("listitem").filter((li) => li.dataset.seq);
    expect(steps.map((li) => `${li.dataset.kind}:${li.dataset.status}`)).toEqual(["code:ok", "decision:ok", "action:waiting"]);
    expect(screen.getByText(/done, 1.3 s, claude-haiku-4.5, \$0.00063/)).toBeInTheDocument();
    expect(timelines.count).toBe(1);
    expect(timelines.adds).toBeGreaterThanOrEqual(3 * 2);
  });

  it("is simply there with reduced motion", () => {
    motion(true);
    render(<JobTimeline initial={job()} api={{ load: async () => job() }} />);
    expect(timelines.count).toBe(0);
    expect(screen.getByText("Find low stock")).toBeInTheDocument();
  });

  it("lets the owner open a step, and shows the question to answer", async () => {
    motion(true);
    const answered: string[] = [];
    render(<JobTimeline initial={job()} api={{ load: async () => job({ status: "running", approvals: [] }), answer: async (_id, a) => void answered.push(a) }} />);
    fireEvent.click(screen.getByRole("button", { name: "Find low stock" }));
    expect(screen.getByText("What went in")).toBeInTheDocument();
    // The question shows once, in its card.
    expect(screen.getAllByText(approval.question)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(answered).toEqual(["Yes"]));
  });

  it("shows the maker how it ran on someone else's copy, and nothing to open", () => {
    motion(true);
    const steps = job().steps.map(({ input, output, outcome, note, calls, ...rest }) => rest);
    render(<JobTimeline initial={job({ viewer: "maker", mine: false, steps, approvals: [], untrusted: [] })} api={{ load: async () => job() }} />);
    expect(screen.getByText(/you see how it ran, never what it saw or made/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find low stock" })).toBeDisabled();
  });
});

describe("a question", () => {
  it("offers each answer with what happens then, and says how it ended", async () => {
    const said: string[] = [];
    const { rerender } = render(<ApprovalCard approval={approval} onAnswer={async (a) => void said.push(a)} />);
    expect(screen.getByText('It goes on to "Owner said yes?" with "No" as your answer.')).toBeInTheDocument();
    expect(screen.getByText(/After 24 hours with no answer, the job stops\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    await waitFor(() => expect(said).toEqual(["No"]));
    rerender(<ApprovalCard approval={{ ...approval, status: "expired" }} onAnswer={async () => {}} />);
    expect(screen.getByText("No answer came in time")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });
});
