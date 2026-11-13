import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ApprovalDTO } from "@/lib/types";
import { ApprovalCard } from "./ApprovalCard";

// An approval the platform asked for shows why, beside the question.

afterEach(cleanup);

const base: ApprovalDTO = {
  id: "a1",
  jobId: "j1",
  installationId: "i1",
  agentName: "Fabric restock",
  stepTitle: "Record the order",
  kind: "safety",
  question: 'Add 2 rows to "Orders"?',
  reason: "Safety check: This order is larger than usual for this shop.",
  options: [
    { label: "Yes", effect: "It goes ahead, and the job is done." },
    { label: "No", effect: "It doesn't go ahead, and the job stops." },
  ],
  noAnswer: "After 24 hours with no answer, it doesn't go ahead, and the job stops.",
  status: "pending",
  answer: null,
  expiresAt: "2026-11-13T10:00:00.000Z",
  createdAt: "2026-11-12T10:00:00.000Z",
};

describe("an approval card", () => {
  it("shows the safety check's reason with the question", () => {
    render(<ApprovalCard approval={base} onAnswer={vi.fn()} />);
    expect(screen.getByText('Add 2 rows to "Orders"?')).toBeInTheDocument();
    expect(screen.getByText("Why it asks").parentElement).toHaveTextContent("Safety check: This order is larger than usual for this shop.");
  });

  it("shows no reason for the agent's own question", () => {
    render(<ApprovalCard approval={{ ...base, kind: "ask", reason: null }} onAnswer={vi.fn()} />);
    expect(screen.queryByText("Why it asks")).toBeNull();
  });

  it("says a payment's money is test USDC on Base Sepolia, and nothing for anything else", () => {
    render(<ApprovalCard approval={{ ...base, question: "Pay 2.00 USDC to Weftworks?", money: { network: "Base Sepolia", test: true } }} onAnswer={vi.fn()} />);
    expect(screen.getByText("Amounts here are test USDC on Base Sepolia, worth nothing while boardofserv is a beta.")).toBeInTheDocument();
    cleanup();
    render(<ApprovalCard approval={base} onAnswer={vi.fn()} />);
    expect(screen.queryByText(/test USDC/)).toBeNull();
  });
});

describe("Reppo's second opinion on a card", () => {
  it("says it is still being checked, and the answer buttons work meanwhile", async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(<ApprovalCard approval={{ ...base, opinion: { state: "checking", score: null, route: null, reason: null } }} onAnswer={onAnswer} />);
    expect(screen.getByText("Still being checked. You can answer now.")).toBeInTheDocument();
    expect(screen.getByText("Your answer decides: Reppo never approves or blocks anything.")).toBeInTheDocument();
    screen.getByRole("button", { name: "Yes" }).click();
    expect(onAnswer).toHaveBeenCalledWith("Yes");
  });

  it("shows the score, the route in words and the reason once it comes, or that none came", () => {
    render(<ApprovalCard approval={{ ...base, opinion: { state: "ready", score: 34, route: "review", reason: "The order is larger than usual." } }} onAnswer={async () => undefined} />);
    expect(screen.getByText(/34 out of 100/).closest("span")).toHaveTextContent("34 out of 100, it suggests a closer look. The order is larger than usual.");
    cleanup();
    render(<ApprovalCard approval={{ ...base, opinion: { state: "none", score: null, route: null, reason: null } }} onAnswer={async () => undefined} />);
    expect(screen.getByText("Reppo couldn't give one this time.")).toBeInTheDocument();
    cleanup();
    render(<ApprovalCard approval={{ ...base, opinion: null }} onAnswer={async () => undefined} />);
    expect(screen.queryByText(/Second opinion/)).toBeNull();
  });

  it("lists a run's held messages with their links as text, the risky one flagged", () => {
    const held: ApprovalDTO = {
      ...base,
      stepTitle: "Its messages",
      question: "Send these 2 messages to you? Each carries links you didn't give it.",
      opinion: { state: "ready", score: 41, route: "review", reason: "A shortened link asking to claim something is a common lure." },
      items: [
        { text: "Tidewatch: try the demo at https://tidewatch.example/demo", links: [{ link: "https://tidewatch.example/demo", risky: false }] },
        { text: "Prize Corner: try the demo at http://bit.ly/claim-prize", links: [{ link: "http://bit.ly/claim-prize", risky: true }] },
      ],
      options: [
        { label: "Yes to all", effect: "All 2 are sent to you." },
        { label: "No to all", effect: "None of them is sent." },
        { label: "Pick one by one", effect: "You're asked about each one on its own." },
      ],
    };
    render(<ApprovalCard approval={held} onAnswer={async () => undefined} />);
    const items = screen.getAllByRole("listitem").filter((li) => li.textContent?.includes("Links:"));
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent("http://bit.ly/claim-prizeReppo calls this risky");
    expect(items[0]).not.toHaveTextContent("risky");
    // Text to read, never a link to follow.
    expect(screen.queryByRole("link", { name: /bit\.ly/ })).toBeNull();
    expect(screen.getByText(/41 out of 100/).closest("span")).toHaveTextContent("41 out of 100, it suggests a closer look. A shortened link asking to claim something is a common lure.");
    expect(["Yes to all", "No to all", "Pick one by one"].every((n) => screen.getByRole("button", { name: n }))).toBe(true);
  });
});
