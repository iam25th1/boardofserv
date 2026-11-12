import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { hackathonDefinition } from "@/test/hackathonFixture";
import { TOOL_NAMES } from "@/lib/agents/definition";
import type { AgentBuilderDTO, AgentSummaryDTO } from "@/lib/types";
import { emptyBench } from "@/lib/agents/types";
import { AgentSimple, type SimpleApi } from "./AgentSimple";

// The agent's page with details off: what it does, its steps in plain
// sentences, what it connects to and asks before doing, Test it and
// Publish, and a problem as one sentence with Fix this. Never a value's or
// a tool's name, a step's kind, code or JSON.

const d = hackathonDefinition();
const agent = (o: Partial<AgentSummaryDTO> = {}): AgentSummaryDTO => ({
  id: "a1",
  version: 1,
  state: "draft",
  buildState: "idle",
  buildNote: null,
  steps: d.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, next: [], code: s.kind === "code" ? "approved" : null })),
  test: null,
  problem: null,
  ...o,
});
const data = (o: Partial<AgentSummaryDTO> = {}): AgentBuilderDTO => ({
  agent: agent(o),
  name: d.name,
  conversationId: "c1",
  definition: d,
  code: {},
  bench: emptyBench(),
  versions: [],
  runnable: null,
  listing: null,
  review: null,
});
const noApi: SimpleApi = { test: vi.fn(), fix: vi.fn(), publish: vi.fn() };

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the plain agent page", () => {
  it("shows what it does, its steps in order, what it connects to and asks, in plain words", () => {
    const { container } = render(<AgentSimple data={data()} api={noApi} onData={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hackathon Submission Checker");
    expect(screen.getByText("Not tried yet")).toBeInTheDocument();
    // When it runs, in the maker's own time zone from their browser.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByRole("heading", { name: "When it runs" }).parentElement).toHaveTextContent(`Runs every 15 minutes, in your time zone (${zone}).`);
    const steps = screen.getByRole("heading", { name: "Its steps" }).parentElement!.querySelectorAll("li");
    expect([...steps].map((li) => li.textContent)).toEqual([
      "1Read the submissions sheet and pick out the ones not checked yet",
      "2Judge every requirement of every new submission: met or not met",
      "3Count the requirements each one met, and mark it Passed, or Rejected when fewer than half are met",
      "4Write Status and Reasons into each submission's own row",
      "5Send you a summary of the run on Telegram",
    ]);
    expect(screen.getByRole("heading", { name: "What it connects to" }).parentElement).toHaveTextContent("Your Google SheetsYour Telegram");
    expect(screen.getByRole("heading", { name: "What it asks you before doing" }).parentElement).toHaveTextContent("Anything the safety check isn't sure about");
    // Never a value's or a tool's name, a step's kind, code or JSON.
    const text = container.textContent ?? "";
    const names = [...d.steps.flatMap((s) => [s.id, ...s.inputs, ...s.outputs]), ...d.settings.map((s) => s.key), ...d.actions.map((a) => a.id)].filter((n) => n.includes("_"));
    for (const name of names) expect(text, name).not.toContain(name);
    for (const tool of TOOL_NAMES) expect(text, tool).not.toContain(tool);
    expect(text).not.toMatch(/[{}[\]]|\bdecision\b|\baction\b|\bcode step\b/i);
  });

  it("shows a problem as one sentence, and Fix this fixes it with no typing", async () => {
    const problem = { text: '"Count and mark" didn\'t pass SERV\'s check of its code, so it\'s on hold.', step: "tally", fix: "rewrite" as const };
    const fix = vi.fn(async () => agent({ buildState: "writing" }));
    const onData = vi.fn();
    render(<AgentSimple data={data({ problem })} api={{ ...noApi, fix }} onData={onData} />);
    expect(screen.getByText("Something needs fixing")).toBeInTheDocument();
    expect(screen.getByText(problem.text)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Fix this" })));
    expect(fix).toHaveBeenCalledWith(problem);
    expect(onData).toHaveBeenCalledWith(expect.objectContaining({ agent: expect.objectContaining({ buildState: "writing" }) }));
  });

  it("tests itself on its own sample data and tells the run as a story", async () => {
    const story = "3 submissions checked: 2 passed, 1 rejected, summary sent.";
    let shown = data();
    const test = vi.fn(async () => agent({ test: { status: "passed", story, checkedAt: "2026-11-11T00:00:00Z" } }));
    const { rerender } = render(<AgentSimple data={shown} api={{ ...noApi, test }} onData={(next) => (shown = next)} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Test it" })));
    rerender(<AgentSimple data={shown} api={{ ...noApi, test }} onData={(next) => (shown = next)} />);
    expect(screen.getByText(story)).toBeInTheDocument();
    expect(screen.getByText("Tried, not ready to run yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test it again" })).toBeInTheDocument();
  });
});
