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
  test: null,
  problem: null,
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
    // Only what the chat asks: what it sets up and remembers aren't topics.
    expect(dots).toEqual(["on", "on", "ask", "off", "off"]);
    expect(screen.getByText("2 of 5 answered")).toBeInTheDocument();
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
    expect(screen.getByText("Writing its steps, 0 of 1 ready")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/app/agents/a1");
    cleanup();
    const ready = render(<AgentDock sketch={done} agent={agent()} />);
    expect(ready.container.querySelector('[data-node="find_low"]')!.getAttribute("data-state")).toBe("ready");
    expect(screen.getByText("Ready to test")).toBeInTheDocument();
  });

  it("says where the build is in plain words", () => {
    expect(agentStatus(done, agent({ buildState: "planning", steps: [] }))).toBe("Planning the steps...");
    expect(agentStatus(done, agent({ buildState: "failed", steps: [], buildNote: "The plan didn't come together: it didn't say what starts it." }))).toBe("The plan didn't come together");
    expect(agentStatus(done, agent({ buildState: "failed" }))).toBe("The change didn't come together");
    expect(agentStatus(done, agent({ steps: agent().steps.map((s) => (s.kind === "code" ? { ...s, code: "needs_attention" } : s)) }))).toBe("Something needs fixing");
    expect(agentStatus(done, agent({ test: { status: "passed", story: "3 items checked.", checkedAt: "2026-11-11T00:00:00Z" } }))).toBe("Tested, ready to publish");
    expect(agentStatus(done, agent({ state: "published" }))).toBe("Published, version 1");
    expect(agentStatus({ ...interview, asking: null }, null)).toBe("Interviewing");
  });

  it("once planned, says where it stands and offers Test it, Fix it, Publish and Details", () => {
    const actions = { onTest: vi.fn(), onFix: vi.fn(), onPublish: vi.fn(), busy: null };
    const story = "3 items checked: 2 passed, 1 rejected, summary sent.";
    render(<AgentDock sketch={done} agent={agent({ test: { status: "passed", story, checkedAt: "2026-11-11T00:00:00Z" } })} actions={actions} />);
    expect(screen.getByText("Tested, ready to publish")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(story);
    // No Open, no Plan: the card does it all.
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Test it" }));
    fireEvent.click(screen.getByRole("button", { name: "Fix it" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect([actions.onTest, actions.onFix, actions.onPublish].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(screen.getByRole("link", { name: "Details" })).toHaveAttribute("href", "/app/agents/a1?details=1");
    cleanup();
    // A problem reads in one sentence, and nothing can be published.
    const problem = { text: '"Find low stock" didn\'t pass SERV\'s check of its code, so it\'s on hold.', step: "find_low", fix: "rewrite" as const };
    render(<AgentDock sketch={done} agent={agent({ problem })} actions={actions} />);
    expect(screen.getByText("Something needs fixing")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(problem.text);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });
});
