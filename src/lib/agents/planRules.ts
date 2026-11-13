import { nextOf, REASON_TOOL, type AgentDefinition, type AgentStep } from "./definition";
import { shapeProblems } from "./shapes";

// The planner's rules beyond the format (definition.ts checks the format):
// a plan that breaks one goes back to SERV with the reason, like any plan
// that doesn't check out. Each reason names the step, for SERV; the maker
// reads them in plain words (plainWords.ts).
//
// - Judgement goes to decisions; counting, comparing, thresholds and
//   whether any items are left go to code. A decision whose question is a
//   count, a comparison or "is there another row" is the wrong kind of step,
//   and so is a code step whose job is to judge.
// - A judgement with no fixed outcomes (a score with its reasons, a
//   rating) and words for people (a reply, feedback, a line for the day, a
//   summary of what a page says) are made by SERV at run time: the code
//   step that makes one asks SERV (serv.reason). Code never stands in for
//   the model with word counts, keyword lists or canned lines.
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
// A comparison of values: below or above a target, over a limit.
const COMPARES = /\b(?:below|above|under|over|exceeds?|greater|less|more than|fewer|at or (?:below|above)|compar\w+|threshold|higher|lower)\b/i;
const judges = (text: string) => JUDGES.test(text) || text.split(/[.;:]/).some((sentence) => WEIGHS.test(sentence) && !COUNTS.test(sentence));

// A step whose job is reasoning only a model can do: a score, a rating or
// a grade of how good something is; words for people that the data alone
// doesn't make (a reply, feedback, a line for the day); a summary of what
// a text says; a sentiment, a tone or a category picked by reading. A
// sentence about counting or combining verdicts is code's own work.
const SCORES = /\b(?:scor(?:e|es|ed|ing)|rat(?:e|es|ed|ing)|grad(?:e|es|ed|ing))\b[^.;:]*\b(?:quality|how (?:good|well|strong|clear|original|useful)|merit|strength|originality|clarity|impact|creativity|potential|out of \d+|from \d+ to \d+|1 to 10|1-10)\b|\b(?:quality|merit|strength|originality|clarity) (?:score|rating|grade)s?\b/i;
const NOT_SCORES = /\b(?:rate limits?|exchange rates?|interest rates?|rates? of|price|prices)\b/i;
const WRITES =
  /\b(?:writ(?:e|es|ing)|draft(?:s|ed|ing)?|compos(?:e|es|ing)|generat(?:e|es|ing)|craft(?:s|ing)?|come up with|comes up with|pick(?:s|ing)?|choos(?:e|es|ing)|select(?:s|ing)?)\b[^.;:]*\b(?:repl(?:y|ies)|responses?|answers? to (?:the |each |this )?(?:enquir|question|message|customer|email)|emails?|feedback|motivational|inspirational|quotes?|poems?|stor(?:y|ies)|captions?|posts?|tweets?|tips?|advice|suggestions?|recommendations?|greetings?|jokes?|line for the day|words of)\b/i;
const SUMMARISES = /\bsummari[sz](?:e|es|ed|ing)\b[^.;:]*\b(?:page|article|text|post|news|content|emails?|messages? (?:it|they|people|customers) (?:sent|wrote)|enquir|submissions?|feedback|reviews?|transcript|document)s?\b/i;
const READS_FOR = /\b(?:sentiment|tone of|classif(?:y|ies|ying)|categori[sz](?:e|es|ing))\b/i;
// Words that are made up, not worked out: a line for the day, a joke.
const CREATIVE = /\b(?:motivational|inspirational|uplifting|encouraging|affirmations?|poems?|jokes?|riddles?|fun facts?|quote of the day|words of (?:wisdom|encouragement))\b/i;
// Words the maker wrote themselves, filled in: no model needed.
const TEMPLATE = /\btemplates?\b|\bfill(?:s|ing)? in\b/i;
const COMBINES = /\b(?:count\w*|how many|number of|verdicts?|tally|tallies|sum(?:s|med)?|total(?:s|led)?)\b/i;
const reasonsIn = (text: string) =>
  text
    .split(/(?<=[.;:])\s+/)
    .some((sentence) => !COMBINES.test(sentence) && !TEMPLATE.test(sentence) && ((SCORES.test(sentence) && !NOT_SCORES.test(sentence)) || WRITES.test(sentence) || SUMMARISES.test(sentence) || READS_FOR.test(sentence) || CREATIVE.test(sentence)));

// Whether a code step's job needs SERV at run time: its brief (or, for a
// short brief, its title) asks for a judgement or words only a model can
// give.
export function needsReasoning(step: AgentStep): boolean {
  if (step.kind !== "code") return false;
  // Filling in the maker's own template is the maker's words.
  if (TEMPLATE.test(step.description)) return false;
  return reasonsIn(step.description) || reasonsIn(step.title);
}

// A step that says it reads ("Read the submission") and is given nothing
// to read and no tool to read with only makes up what it passes on.
const SAYS_READS = /^(?:read|fetch|get|load|pull|collect|gather|download|import)\b/i;
const READ_TOOLS = ["web.fetch", "sheets.read", "web.search", "memory.get", "typeform.read"];

export function planProblems(d: AgentDefinition): string[] {
  const out: string[] = [];
  for (const s of d.steps) {
    if (s.kind !== "code" || !SAYS_READS.test(s.title) || s.tools.some((t) => READ_TOOLS.includes(t))) continue;
    if (s.inputs.every((k) => k === "settings" || k === "rules")) out.push(`code step "${s.id}" says it reads ("${s.title}") but has no tool that reads and nothing given to it to read, so it could only make up what it passes on: list the tool it reads with (web.fetch for a public page, sheets.read for a sheet, typeform.read for a Typeform form). Any other form's link can't be read at all: its answers come from the sheet they go to, a setting of type sheet.`);
  }
  // SERV for a plain comparison (is the price below the target?): code's
  // own work, never a model's.
  for (const s of d.steps) {
    if (s.kind !== "code" || !s.tools.includes(REASON_TOOL)) continue;
    const asked = s.description.split(/(?<=[.;])\s+/).filter((x) => /\bserv\.reason\b|\bSERV\b/.test(x));
    if (asked.length && asked.every((x) => COMPARES.test(x) && !reasonsIn(x))) out.push(`code step "${s.id}" asks SERV to compare ("${s.title}"): a comparison of numbers (below or above a target, over a limit) is code's own work, never SERV's. Work it out in the code and take serv.reason off its tools.`);
  }
  for (const s of d.steps) {
    if (s.kind !== "code") continue;
    const asks = s.tools.includes(REASON_TOOL);
    if (judges(s.description) && !asks) out.push(`code step "${s.id}" judges ("${s.title}"): judgement goes to a decision step, inside a loop when there are many items; code only counts and combines its verdicts.`);
    else if (needsReasoning(s) && !asks) out.push(`code step "${s.id}" makes a judgement or words only a model can ("${s.title}"): its code must ask SERV at run time. List serv.reason in its tools and say in its description what SERV is asked, with which values, and the fields it answers (a score with its reasons, the reply's text); never a word count, a keyword list or a canned line.`);
  }
  for (const s of d.steps) {
    // A decision that goes by a value a step worked out judges nothing.
    if (s.kind !== "decision" || s.from) continue;
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
  // What passes between steps fits what reads it (shapes.ts).
  out.push(...shapeProblems(d));
  return [...new Set(out)];
}
