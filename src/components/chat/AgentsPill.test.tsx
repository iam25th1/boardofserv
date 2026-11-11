import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ConversationDTO } from "@/lib/types";
import { AgentsPill } from "./AgentsPill";

// The agents pill counts exactly what its list holds, and two chats with
// the same name each say which is which.

const at = (iso: string) => ({ createdAt: iso, updatedAt: iso });
const CHATS: ConversationDTO[] = [
  { id: "c1", title: "Check my hackathon sheet", sketchName: "Hackathon Submission Checker", publishedSlug: null, ...at(new Date(Date.now() - 60_000).toISOString()) },
  { id: "c2", title: "Check submissions again", sketchName: "Hackathon Submission Checker", publishedSlug: null, ...at(new Date(Date.now() - 3_600_000).toISOString()) },
  { id: "c3", title: "Daily Gmail summary", sketchName: null, publishedSlug: null, ...at(new Date(Date.now() - 7_200_000).toISOString()) },
];

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the agents pill", () => {
  it("counts what its list holds, and tells same-named chats apart", () => {
    render(<AgentsPill conversations={CHATS} activeId={null} replyingId={null} onNew={() => {}} onSelect={() => {}} onRename={() => {}} onDelete={() => {}} />);
    const pill = screen.getByRole("button", { name: "3 agents" });
    fireEvent.click(pill);
    const rows = screen.getAllByRole("button", { name: /^(Hackathon Submission Checker|Daily Gmail summary)/ });
    expect(rows).toHaveLength(3);
    const same = rows.filter((r) => r.textContent!.includes("Hackathon Submission Checker"));
    expect(same.map((r) => within(r).getByText(/^Draft, started /).textContent)).toHaveLength(2);
    expect(new Set(same.map((r) => r.textContent)).size).toBe(2);
    // A chat with no sketch goes by its first message, with no detail.
    expect(screen.getByRole("button", { name: /^Daily Gmail summary/ })).toHaveTextContent("No sketch yet");
  });
});
