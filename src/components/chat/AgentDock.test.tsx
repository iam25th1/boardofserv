import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentSummaryDTO, SketchDTO } from "@/lib/types";
import { AgentDock, agentStatus } from "./AgentDock";

// The agent's dock: the interview while SERV asks, then the real steps.

const interview: SketchDTO = {
  name: "Fabric restock",
  kind: "agent",
  watches: null,
  when: null,
  how: null,
  tells: null,
  takes: null,
  does: null,
  gives: null,
  wakes: "every morning at eight",
  looks: "the Stock sheet",
  handles: null,
  finish: null,
  asks: null,
  setup: null,
  remembers: null,
  asking: "handles",
  live: false,
};
const done: SketchDTO = { ...interview, handles: "orders what is low", finish: "an order is recorded", asks: "orders over 250 USDC", setup: "the sheets", remembers: "the last order", asking: null };

const agent = (o: Partial<AgentSummaryDTO> = {}): AgentSummaryDTO => ({
  id: "a1",
  version: 1,
  state: "draft",
  buildState: "idle",
  buildNote: null,
  steps: [
    { id: "find_low", title: "Find low stock", kind: "code", next: ["decide"], code: "approved" },
    { id: "decide", title: "Order?", kind: "decision", next: ["record", null], code: null },
    { id: "record", title: "Record", kind: "action", next: [null], code: null },
  ],
  ...o,
});

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the agent dock", () => {
  it("shows the interview as it is answered, the question being asked turning", () => {
    const { container } = render(<AgentDock sketch={interview} agent={null} onPlan={() => {}} />);
    const dots = [...container.querySelectorAll("[data-state]")].map((g) => g.getAttribute("data-state"));
    expect(dots).toEqual(["on", "on", "ask", "off", "off", "off", "off"]);
    expect(screen.getByText("2 of 7 answered")).toBeInTheDocument();
    expect(screen.getByText("Waiting on one answer from you")).toBeInTheDocument();
    // No Plan until the interview is done.
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Fabric restock/ }));
    expect(screen.getByText("Asks you before")).toBeInTheDocument();
    expect(screen.getByText("waiting on you")).toBeInTheDocument();
  });

  it("offers Plan once the interview is done", () => {
    const onPlan = vi.fn();
    render(<AgentDock sketch={done} agent={null} onPlan={onPlan} />);
    expect(screen.getByText("Ready to plan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(onPlan).toHaveBeenCalledOnce();
  });

  it("shows the real steps once planned, each as its code stands, and opens the builder", () => {
    const { container } = render(<AgentDock sketch={done} agent={agent({ buildState: "writing", steps: agent().steps.map((s) => (s.id === "find_low" ? { ...s, code: "reviewing" } : s)) })} onPlan={() => {}} />);
    expect(container.querySelector('[data-node="find_low"]')!.getAttribute("data-state")).toBe("writing");
    expect(container.querySelector('[data-node="decide"]')!.getAttribute("data-state")).toBe("planned");
    expect(screen.getByText("Writing code, 0 of 1 ready")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/app/agents/a1");
    cleanup();
    const ready = render(<AgentDock sketch={done} agent={agent()} />);
    expect(ready.container.querySelector('[data-node="find_low"]')!.getAttribute("data-state")).toBe("ready");
    expect(screen.getByText("Ready to test")).toBeInTheDocument();
  });

  it("says where the build is in plain words", () => {
    expect(agentStatus(done, agent({ buildState: "planning", steps: [] }))).toBe("Planning the steps...");
    expect(agentStatus(done, agent({ buildState: "failed", buildNote: "The plan didn't come together after 3 tries. Try again, or add a detail in the chat." }))).toMatch(/^The plan didn't come together/);
    expect(agentStatus(done, agent({ steps: agent().steps.map((s) => (s.kind === "code" ? { ...s, code: "needs_attention" } : s)) }))).toBe("A step needs your attention");
    expect(agentStatus(done, agent({ state: "published" }))).toBe("In testing");
    expect(agentStatus({ ...interview, asking: null }, null)).toBe("Interviewing");
  });
});
