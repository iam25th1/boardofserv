// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkDefinition, type AgentDefinition } from "./definition";
import { actingSteps, leaveOut, purposeRequest, readPurpose } from "./purpose";

// The planner and the guard agree: a planned step the guard would block
// every run ("Update scoring memory", blocked live as outside what the
// Hackathon Submission Scorer is for) is left out before the plan is kept.

function scorer(): AgentDefinition {
  const c = checkDefinition({
    format: 1,
    name: "Hackathon Submission Scorer",
    job: { does: "Scores each submission it is sent from 1 to 10 for quality and sends you the score with reasons.", done: "The submission has a score." },
    triggers: [{ kind: "message", from: "telegram", description: "When a submission comes in" }],
    settings: [],
    rules: [],
    memory: [{ key: "last_score", description: "The last score it gave", type: "number" }],
    steps: [
      { id: "score", title: "Score submission quality", kind: "code", inputs: ["trigger"], outputs: ["assessment"], description: "Ask SERV with serv.reason to score trigger.text from 1 to 10 for quality, with answer { score: number, reasons: text }. Return assessment.", tools: ["serv.reason"], next: "make" },
      { id: "make", title: "Write the message", kind: "code", inputs: ["assessment"], outputs: ["message"], description: "Return message { text } with the score and reasons.", tools: [], next: "send" },
      { id: "send", title: "Send the assessment", kind: "action", action: "send_assessment", inputs: ["message"], outputs: [], next: "note" },
      { id: "note", title: "Make the note", kind: "code", inputs: ["assessment"], outputs: ["remember"], description: "Return remember as memory.set's arguments: the key last score, and the assessment's score.", tools: [], next: "save" },
      { id: "save", title: "Update scoring memory", kind: "action", action: "save_score", inputs: ["remember"], outputs: [], next: null },
    ],
    actions: [
      { id: "send_assessment", tool: "telegram.send", description: "Send you the assessment" },
      { id: "save_score", tool: "memory.set", description: "Remember the last score" },
    ],
    limits: { maxSteps: 10, maxRunSeconds: 60, maxSpendUsd: 0.2 },
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
}

const answer = (steps: unknown[]) => ({ content: JSON.stringify({ steps }), provider: "serv", model: "m", promptTokens: 1, completionTokens: 1, totalMs: 1, failures: [] }) as never;

describe("the guard's view of a plan", () => {
  it("asks about every step that acts, with what the agent is for and the maker's words", () => {
    const d = scorer();
    expect(actingSteps(d).map((s) => s.id)).toEqual(["send", "save"]);
    const text = purposeRequest(d, ["Score each submission and send me the score with reasons."]);
    expect(text).toContain("What it is for: Scores each submission");
    expect(text).toContain("- Score each submission and send me the score with reasons.");
    expect(text).toContain('"id":"save","title":"Update scoring memory","does":"Remember the last score","tool":"memory.set"');
  });

  it("leaves out a step the guard would block, with the code that only fed it, and the plan still checks out", () => {
    const d = scorer();
    const verdicts = readPurpose(d, answer([{ id: "send", verdict: "fits", reason: "It is the job." }, { id: "save", verdict: "outside", reason: "Remembering scores is outside what this agent is for." }]));
    const out = leaveOut(d, verdicts);
    expect(out.dropped).toEqual([{ title: "Update scoring memory", reason: "Remembering scores is outside what this agent is for." }]);
    expect(out.definition.steps.map((s) => s.id)).toEqual(["score", "make", "send"]);
    expect(out.definition.steps.find((s) => s.id === "send")).toMatchObject({ next: null });
    expect(out.definition.actions.map((a) => a.id)).toEqual(["send_assessment"]);
    expect(checkDefinition(out.definition).ok).toBe(true);
  });

  it("keeps the plan when the guard says it fits, or doesn't answer, and never leaves out the job itself", () => {
    const d = scorer();
    expect(leaveOut(d, readPurpose(d, answer([{ id: "save", verdict: "ask", reason: "x" }]))).definition).toEqual(d);
    expect(leaveOut(d, readPurpose(d, { content: null } as never)).definition).toEqual(d);
    // The send can't go: the steps after it would have nothing leading to them.
    const sendOut = leaveOut(d, [{ id: "send", verdict: "outside", reason: "x" }]);
    expect(sendOut.dropped).toEqual([]);
    expect(sendOut.kept).toEqual([{ id: "send", verdict: "outside", reason: "x" }]);
  });
});
