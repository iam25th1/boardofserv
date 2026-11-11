import { nextOf, type AgentDefinition } from "./definition";

// The planner's rules beyond the format (definition.ts checks the format):
// a plan that breaks one goes back to SERV with the reason, like any plan
// that doesn't check out. Each reason names the step, for SERV; the maker
// reads them in plain words (plainWords.ts).
//
// - Judgement goes to decisions; counting, comparing, thresholds and
//   whether any items are left go to code. A decision whose question is a
//   count, a comparison or "is there another row" is the wrong kind of step.
// - Steps never loop back. Going through many items happens inside a code
//   step, or in one decision over a list (each); a loop through the steps
//   leaves later steps with only the last time round's values.
// - A saved position builds on the one saved before: the step that saves
//   to memory reads it first.

const COUNTING =
  /\bhow many\b|\bcount(?:s|ing)?\b|\b(?:fewer|less|more|greater) than (?:half|\d)|\bat (?:least|most) (?:half|\d)|\bhalf (?:of|the)\b|\bthreshold\b|\b\d+\s*(?:%|percent)\b|\bover \d|\bunder \d|\bexceeds?\b|\bequal(?:s)? to\b/i;
const LEFT = /\b(?:any|more|another|next|other)\s+(?:new\s+)?(?:rows?|items?|entries|submissions?|records?|messages?|ones?)\b|\b(?:rows?|items?|submissions?|records?|entries)\s+(?:left|remaining|to (?:process|check|go|handle))\b|\bis there (?:another|a next|one more|anything)\b|\bany (?:left|remaining)\b/i;

export function planProblems(d: AgentDefinition): string[] {
  const out: string[] = [];
  for (const s of d.steps) {
    if (s.kind !== "decision") continue;
    const words = [s.title, s.prompt, ...s.outcomes.map((o) => o.label)].join(" ");
    if (LEFT.test(words)) out.push(`decision "${s.id}" decides whether items are left to go through ("${s.title}"): is there another row is code, never a decision. Go through the list inside a code step, or judge every item with one decision over the list (each).`);
    else if (COUNTING.test(words)) out.push(`decision "${s.id}" decides a count or a comparison ("${s.title}"): work it out in a code step. Decisions are only for judgement.`);
  }

  // A step that leads back to one that comes before it on the way from the
  // first step.
  const byId = new Map(d.steps.map((s) => [s.id, s]));
  const state = new Map<string, "open" | "done">();
  const loops: string[] = [];
  const visit = (id: string) => {
    state.set(id, "open");
    for (const n of nextOf(byId.get(id)!)) {
      if (!n || !byId.has(n)) continue;
      if (state.get(n) === "open") loops.push(`step "${id}" loops back to "${n}"`);
      else if (!state.has(n)) visit(n);
    }
    state.set(id, "done");
  };
  if (d.steps[0]) visit(d.steps[0].id);
  for (const l of loops) out.push(`${l}: steps never loop back, so whatever comes after would see only the last time round. Go through the list inside one code step, or judge every item with one decision over the list (each).`);

  // Saving to memory without reading what was saved before.
  const memorySetActions = new Set(d.actions.filter((a) => a.tool === "memory.set").map((a) => a.id));
  const argsFor = new Set(d.steps.flatMap((s) => (s.kind === "action" && memorySetActions.has(s.action) && s.inputs[0] ? [s.inputs[0]] : [])));
  for (const s of d.steps) {
    if (s.kind !== "code") continue;
    const saves = s.tools.includes("memory.set") || s.outputs.some((o) => argsFor.has(o));
    if (saves && !s.inputs.includes("memory") && !s.tools.includes("memory.get")) {
      out.push(`step "${s.id}" saves to memory without reading what was saved before: list "memory" in its inputs and build on it (a position keeps the larger of the old and the new).`);
    }
  }
  return [...new Set(out)];
}
