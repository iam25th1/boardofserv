import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { layoutSteps, StepDiagram, type DiagramStep } from "./StepDiagram";

// The agent's steps in chalk: a shape per kind, a link per next step, and
// the states the build and the test bench give them.

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
  };
});

const STEPS: DiagramStep[] = [
  { id: "find_low", title: "Find low stock", kind: "code", next: ["compare"] },
  { id: "compare", title: "Compare suppliers", kind: "code", next: ["check_total"] },
  { id: "check_total", title: "Big order?", kind: "decision", next: ["ask_owner", "record"] },
  { id: "ask_owner", title: "Ask the owner", kind: "action", next: ["approved"] },
  { id: "approved", title: "Owner said yes?", kind: "decision", next: ["record", null] },
  { id: "record", title: "Record the order", kind: "action", next: [null] },
];

function motion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
}

beforeEach(() => {
  timelines.count = 0;
  timelines.adds = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the step diagram", () => {
  it("draws a code step as a square, a decision as a diamond and an action as a circle", () => {
    motion(true);
    const { container } = render(<StepDiagram steps={STEPS} />);
    const shape = (id: string) => container.querySelector(`[data-node="${id}"] [data-outline]`)!.tagName;
    expect([shape("find_low"), shape("check_total"), shape("ask_owner")]).toEqual(["rect", "polygon", "circle"]);
    expect(screen.getByRole("img", { name: "The agent's steps: 6 steps" })).toBeInTheDocument();
    expect(screen.getByText("Big order?: decision step, planned")).toBeInTheDocument();
  });

  it("links each step to the next, one per outcome, and lays them out by distance from the first", () => {
    const layout = layoutSteps(STEPS);
    expect(layout.links.map((l) => l.key)).toEqual(["find_low>compare", "compare>check_total", "check_total>ask_owner", "check_total>record", "ask_owner>approved", "approved>record"]);
    const x = Object.fromEntries(layout.nodes.map((n) => [n.id, n.x]));
    expect(x.find_low! < x.compare! && x.compare! < x.check_total!).toBe(true);
    // ask_owner and record are both one step after the decision: one column.
    expect(x.ask_owner).toBe(x.record);
    // A link back to an earlier step loops underneath, dashed.
    const loop = layoutSteps([...STEPS.slice(0, 5), { id: "record", title: "Record", kind: "action", next: ["find_low"] }]);
    expect(loop.links.find((l) => l.key === "record>find_low")?.back).toBe(true);
  });

  it("shows each step's state, and fills a ready step in", () => {
    motion(true);
    const { container } = render(<StepDiagram steps={STEPS} states={{ find_low: "ready", compare: "writing", check_total: "attention", record: "active" }} />);
    const state = (id: string) => container.querySelector(`[data-node="${id}"]`)!.getAttribute("data-state");
    expect(["find_low", "compare", "check_total", "ask_owner", "record"].map(state)).toEqual(["ready", "writing", "attention", "planned", "active"]);
    expect(container.querySelector('[data-node="check_total"] text')!.textContent).toBe("!");
    const fill = container.querySelector('[data-node="find_low"] [data-fill]') as SVGElement;
    expect(fill.style.transform).toContain("scale(0.62)");
  });

  it("chalks new steps and their links on, and only the new ones as the plan grows", () => {
    motion(false);
    const { rerender } = render(<StepDiagram steps={STEPS.slice(0, 2)} />);
    expect(timelines.count).toBe(1);
    const before = timelines.adds;
    rerender(<StepDiagram steps={STEPS.slice(0, 3)} />);
    expect(timelines.count).toBe(2);
    expect(timelines.adds - before).toBeGreaterThan(0);
  });

  it("doesn't animate at all with reduced motion", () => {
    motion(true);
    render(<StepDiagram steps={STEPS} />);
    expect(timelines.count).toBe(0);
  });
});
