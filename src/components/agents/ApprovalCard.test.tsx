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
});
