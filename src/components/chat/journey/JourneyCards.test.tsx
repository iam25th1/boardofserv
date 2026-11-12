import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentSummaryDTO } from "@/lib/types";
import type { JourneyCard } from "@/lib/journey";
import { JourneyCardView, type JourneyApi } from "./JourneyCards";

// While a build heals itself the cards say so in calm plain lines; when it
// gives up, one sentence and two choices. Never "on hold", a review's
// reason, code, or a box to describe a fix.

const at = "2026-11-11T10:00:00.000Z";
const later = "2026-11-11T10:01:00.000Z";
const plain = [
  { id: "read_price", text: "Read the price", depth: 0 },
  { id: "make_reminder", text: "Write the reminder", depth: 0 },
  { id: "send", text: "Send you the reminder", depth: 0 },
];
const agent = (o: Partial<AgentSummaryDTO> = {}): AgentSummaryDTO => ({
  id: "a1",
  version: 1,
  state: "draft",
  buildState: "idle",
  buildNote: null,
  steps: [
    { id: "read_price", title: "Read the price", kind: "code", next: [], code: "approved" },
    { id: "make_reminder", title: "Write the reminder", kind: "code", next: [], code: "approved" },
    { id: "send", title: "Send", kind: "action", next: [], code: null },
  ],
  test: null,
  problem: null,
  plain,
  ...o,
});
const api = (): JourneyApi => ({
  makeIt: vi.fn(),
  looksRight: vi.fn(),
  change: vi.fn(),
  fix: vi.fn(),
  retry: vi.fn(),
  connect: vi.fn(),
  goLive: vi.fn(),
  simpler: vi.fn(async () => undefined),
  describeAgain: vi.fn(),
  installation: vi.fn(),
  connections: vi.fn(async () => ({ connections: [], available: { telegram: true, google: true } })),
  telegramCode: vi.fn(),
  googleStart: vi.fn(),
  inspectSheet: vi.fn(),
});
const show = (card: JourneyCard, a: AgentSummaryDTO, x = api(), latest = true) => render(<JourneyCardView card={card} latest={latest} agent={a} sketch={null} conversationId="c1" api={x} />);

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a build healing itself, on its card", () => {
  it("says what it is doing in plain lines while it fixes a step: no hold, no reason, no box", () => {
    const healing = agent({
      buildState: "writing",
      steps: agent().steps.map((s) => (s.id === "make_reminder" ? { ...s, code: "needs_attention" } : s)),
      heal: { lines: [{ text: "Found a problem in step 2. Fixing it.", tone: "working", at: later }, { text: "Writing step 2 again.", tone: "working", at: later }], question: null, gaveUp: null },
    });
    show({ stage: "build", agentId: "a1", at }, healing);
    const card = screen.getByRole("region", { name: "3. Build" });
    expect(within(card).getByRole("list", { name: "What it fixed" })).toHaveTextContent("Found a problem in step 2. Fixing it.Writing step 2 again.");
    expect(within(card).getByRole("status")).toHaveTextContent("Fixing a step");
    expect(card).not.toHaveTextContent(/on hold|review|rejected|code/i);
    expect(within(card).queryByRole("textbox")).toBeNull();
    expect(within(card).queryByRole("button", { name: /write it again/i })).toBeNull();
  });

  it("shows the lines of its own card only, and the test's pass after them", () => {
    const passed = agent({
      test: { status: "passed", story: "Passed. It read the page and sent you a reminder.", checkedAt: later },
      heal: {
        lines: [
          { text: "Found a problem in step 1. Fixing it.", tone: "working", at: "2026-11-11T09:00:00.000Z" },
          { text: "Found a problem in step 2 while trying it. Fixing it.", tone: "working", at: later },
          { text: "Fixed.", tone: "fixed", at: later },
        ],
        question: null,
        gaveUp: null,
      },
    });
    show({ stage: "try", agentId: "a1", at }, passed);
    const card = screen.getByRole("region", { name: "4. Try it" });
    const lines = within(card).getByRole("list", { name: "What it fixed" });
    expect(within(lines).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["Found a problem in step 2 while trying it. Fixing it.", "Fixed."]);
    expect(card).toHaveTextContent("Passed. It read the page and sent you a reminder.");
  });

  it("gives up in one sentence with two plain choices, never a fix box", () => {
    const x = api();
    const stuck = agent({
      test: { status: "failed", story: "It stopped at \"Write the reminder\".", checkedAt: later },
      problem: { text: '"Write the reminder" didn\'t work on the sample product.', step: "make_reminder", fix: "replan" },
      heal: { lines: [{ text: "Found a problem in step 2 while trying it. Fixing it.", tone: "working", at: later }, { text: 'I couldn\'t get step 2, "Write the reminder", to work on its sample.', tone: "stopped", at: later }], question: null, gaveUp: 'I couldn\'t get step 2, "Write the reminder", to work on its sample.' },
    });
    show({ stage: "try", agentId: "a1", at }, stuck, x);
    const card = screen.getByRole("region", { name: "4. Try it" });
    expect(within(card).getAllByText('I couldn\'t get step 2, "Write the reminder", to work on its sample.')).toHaveLength(1);
    expect(within(card).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Describe the job differently" }));
    expect(x.describeAgain).toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Try a simpler version" }));
    expect(x.simpler).toHaveBeenCalled();
  });

  it("keeps the lines an earlier card said, once the journey moved on", () => {
    show({ stage: "try", agentId: "a1", at, snapshot: { status: "passed", story: "Passed. It sent you a reminder.", healed: [{ text: "Found a problem in step 2 while trying it. Fixing it.", tone: "working" }, { text: "Fixed.", tone: "fixed" }] } }, agent(), api(), false);
    const card = screen.getByRole("region", { name: "4. Try it" });
    expect(card).toHaveTextContent("Found a problem in step 2 while trying it. Fixing it.Fixed.Passed. It sent you a reminder.");
  });

  it("waits on the maker's answer to one question, asked below in the chat", () => {
    const asking = agent({
      test: { status: "failed", story: "It stopped.", checkedAt: later },
      heal: { lines: [{ text: "Found a problem while trying it. Fixing it.", tone: "working", at: later }, { text: "I need to ask you one thing.", tone: "asked", at: later }], question: { text: "Which payee should it pay?", choices: ["Designer", "Someone else"], messageId: "m9" }, gaveUp: null },
    });
    show({ stage: "try", agentId: "a1", at }, asking);
    const card = screen.getByRole("region", { name: "4. Try it" });
    expect(within(card).getByRole("status")).toHaveTextContent("One question for you");
    expect(card).toHaveTextContent("Answer the question below, and it carries on.");
    expect(within(card).queryByRole("textbox")).toBeNull();
  });
});
