import { nextOf, type AgentDefinition } from "./definition";

// The planner's rules beyond the format (definition.ts checks the format):
// a plan that breaks one goes back to SERV with the reason, like any plan
// that doesn't check out. Each reason names the step, for SERV; the maker
// reads them in plain words (plainWords.ts).
//
// - Judgement goes to decisions; counting, comparing, thresholds and
//   whether any items are left go to code. A decision whose question is a
//   count, a comparison or "is there another row" is the wrong kind of step,
//   and so is a code step whose job is to judge.
// - Steps never loop back. Going through many items happens inside a code
//   step, or in a loop step (one decision a pass, a loop inside a loop for
//   several judgements per item); a loop made of steps that go back leaves
//   later steps with only the last time round's values.
// - A decision judges one thing: "each requirement" or "every submission"
//   in one decision is a loop's job, one decision a pass.
// - A saved position builds on the one saved before: the step that saves
//   to memory reads it first. And a position read from memory is saved by
//   some step, or every run starts from the beginning again.

const COUNTING =
  /\bhow many\b|\bcount(?:s|ing)?\b|\b(?:fraction|proportion|ratio|percentage)\b|\b(?:fewer|less|more|greater) than (?:half|\d)|\bat (?:least|most) (?:half|\d)|\bhalf (?:of|the)\b|\bthreshold\b|\b\d+\s*(?:%|percent)\b|\bover \d|\bunder \d|\bexceeds?\b|\bequal(?:s)? to\b/i;
const LEFT = /\b(?:any|more|another|next|other)\s+(?:new\s+)?(?:rows?|items?|entries|submissions?|records?|messages?|ones?)\b|\b(?:rows?|items?|submissions?|records?|entries)\s+(?:left|remaining|to (?:process|check|go|handle))\b|\bis there (?:another|a next|one more|anything)\b|\bany (?:left|remaining)\b/i;

// A question about many items at once: "each requirement", "every
// submission", "all the rows".
const MANY = /\b(?:each|every|all(?: of)?(?: the)?)\s+(?:of\s+the\s+)?(?:[a-z]+\s+)?(?:requirements?|criteri(?:a|on)|submissions?|rows?|items?|entries|records?|enquir(?:y|ies)|messages?|products?|criteria)\b/i;

// Code that judges: says it judges or assesses, or works out whether
// something meets a requirement or is good, in a sentence that isn't about
// counting verdicts ("determine if met_count is under half" is counting).
const JUDGES = /\b(?:judge|judges|judging|assess|assesses|assessing)\b/i;
const WEIGHS = /\b(?:evaluat(?:e|es|ed|ing)|determin(?:e|es|ed|ing)) (?:whether|if|how well)\b[^.]*\b(?:meets?|met|good|quality|worth|requirements?)\b/i;
const COUNTS = /\b(?:count\w*|how many|number of|verdicts?)\b/i;
const judges = (text: string) => JUDGES.test(text) || text.split(/[.;:]/).some((sentence) => WEIGHS.test(sentence) && !COUNTS.test(sentence));

export function planProblems(d: AgentDefinition): string[] {
  const out: string[] = [];
  for (const s of d.steps) {
    if (s.kind === "code" && judges(s.description)) out.push(`code step "${s.id}" judges ("${s.title}"): judgement goes to a decision step, inside a loop when there are many items; code only counts and combines its verdicts.`);
  }
  for (const s of d.steps) {
    if (s.kind !== "decision") continue;
    const words = [s.title, s.prompt, ...s.outcomes.map((o) => o.label)].join(" ");
    if (LEFT.test(words)) out.push(`decision "${s.id}" decides whether items are left to go through ("${s.title}"): is there another row is code, never a decision. Go through the items with a loop step instead.`);
    else if (COUNTING.test(words)) out.push(`decision "${s.id}" decides a count or a comparison ("${s.title}"): work it out in a code step. Decisions are only for judgement.`);
    else if (!s.each && MANY.test(s.prompt)) out.push(`decision "${s.id}" judges many things at once ("${s.title}"): a decision judges one item. Put it inside a loop over the items, and when each item has several things to judge (each requirement of each submission), inside a loop inside that loop.`);
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
  for (const l of loops) out.push(`${l}: steps never loop back, so whatever comes after would see only the last time round. Go through the items with a loop step: its steps run once per item, a pass ends at a next of "", and what comes after reads what it gathered from every pass.`);

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
  // Reading a position from memory that no step ever saves.
  const saves = d.actions.some((a) => a.tool === "memory.set") || d.steps.some((s) => s.kind === "code" && s.tools.includes("memory.set"));
  const reader = d.memory.length && !saves ? d.steps.find((s) => s.kind === "code" && (s.inputs.includes("memory") || s.tools.includes("memory.get"))) : undefined;
  if (reader) out.push(`step "${reader.id}" reads its place from memory, but no step saves it, so every run would start again from the beginning: save the new position in a step at the end (memory.set), reading memory first and keeping the larger, or take only rows whose result column is still empty and keep no position.`);
  return [...new Set(out)];
}
