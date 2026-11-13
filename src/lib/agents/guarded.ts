import { nextOf, REASON_TOOL, SIDE_EFFECT_TOOLS, spends, type AgentDefinition, type AgentStep, type ToolName } from "./definition";
import { REASONING_SPEND_FLOOR_USD } from "./planRepairs";
import { checksFor } from "./test";
import type { CheckId } from "./types";

// What a repair can never trade away. The fixer (fixer.ts) changes steps,
// briefs and samples to make a build pass; before any change to the plan
// is kept, the plan's safety-relevant parts are read off it before and
// after, and a change that weakens any of them is turned down
// (build.ts), however much it would help the test pass:
//
// - an owner's yes: a send or a write that only ever happened after the
//   owner said yes still only happens after a yes (a payment always waits
//   for the platform's own approval, whatever the plan says, so a question
//   of the plan's own before one is not what keeps it safe);
// - spending: what spends still spends (and counts against limits), and
//   every limit it asks over stays, at no higher a value;
// - the maker's own rules, schedule and answers: never changed by a repair;
// - the run's own limits on steps, time and model spend: never raised
//   (model spend only to the floor a step asking SERV needs);
// - the checks: the check a test failed still applies after the repair,
//   so it can only pass by doing what the check asks.
//
// The code review, the sandbox and the safety check before each action
// aren't in the plan at all: a repair only ever changes a step's brief and
// its code is written and reviewed again (code.ts), run in the sandbox
// (sandbox.ts), and checked before it acts (guard.ts), whatever the plan.

// The tools that change something the owner can see, which an owner's yes
// can hold back: not a question (asking is not acting) and not a payment
// (the platform's approval holds it back, always).
const HELD: ToolName[] = SIDE_EFFECT_TOOLS.filter((t) => t !== "telegram.ask" && t !== "wallet.pay");
const YES = /^(?:y|yes|ok|okay|approved?|confirm(?:ed)?|go ahead|agreed?|accept(?:ed)?)$/i;

// Where a step goes on without the owner's yes: every way but the yes of a
// decision on their answer to a question.
function onWithoutYes(d: AgentDefinition, step: AgentStep): (string | null)[] {
  if (step.kind !== "decision" || !step.from) return nextOf(step);
  const asked = d.steps.some((s) => s.kind === "action" && s.outputs[0] === step.from && d.actions.find((a) => a.id === s.action)?.tool === "telegram.ask");
  if (!asked) return nextOf(step);
  return step.outcomes.filter((o) => !YES.test(o.id.replace(/_/g, " ")) && !YES.test(o.label)).map((o) => o.next);
}

// The steps the run can reach from the first without the owner's yes.
function reachedWithoutYes(d: AgentDefinition): Set<string> {
  const byId = new Map(d.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const queue = d.steps[0] ? [d.steps[0].id] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const step = byId.get(id);
    if (!step) continue;
    for (const n of onWithoutYes(d, step)) if (n) queue.push(n);
  }
  return seen;
}

// Each held tool's uses: the action steps that take it, and the code steps
// that call it.
function usesOf(d: AgentDefinition): Map<ToolName, string[]> {
  const out = new Map<ToolName, string[]>();
  for (const s of d.steps) {
    const tools = s.kind === "action" ? [d.actions.find((a) => a.id === s.action)?.tool] : s.kind === "code" ? s.tools : [];
    for (const t of tools) if (t && HELD.includes(t)) out.set(t, [...(out.get(t) ?? []), s.id]);
  }
  return out;
}

// The tools that never act without the owner's yes.
export function heldByYes(d: AgentDefinition): ToolName[] {
  const free = reachedWithoutYes(d);
  return [...usesOf(d)].filter(([, steps]) => steps.every((id) => !free.has(id))).map(([t]) => t);
}

export interface SafetyParts {
  held: ToolName[];
  // Every spending action's tool and the limits it asks over, with the
  // values of those limits.
  spending: { id: string; tool: ToolName; askOver: number | null; askOverDay: number | null }[];
  rules: string;
  triggers: string;
  given: Record<string, string>;
  limits: AgentDefinition["limits"];
  checks: CheckId[];
}

const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v);

export function safetyParts(d: AgentDefinition): SafetyParts {
  const value = (key: string | undefined) => {
    const r = key ? d.rules.find((x) => x.key === key) : undefined;
    const n = r ? Number(r.value) : NaN;
    return Number.isFinite(n) ? n : key ? Infinity : null;
  };
  return {
    held: heldByYes(d),
    spending: d.actions.filter(spends).map((a) => ({ id: a.id, tool: a.tool, askOver: value(a.askOver), askOverDay: value(a.askOverDay) })),
    rules: JSON.stringify(sorted(d.rules.map((r) => [r.key, r.type, r.value]).sort())),
    triggers: JSON.stringify(sorted(d.triggers)),
    given: Object.fromEntries(d.settings.flatMap((s) => (s.given ? [[s.key, s.given]] : []))),
    limits: d.limits,
    checks: checksFor(d),
  };
}

// Why this repair weakens what keeps the agent safe, in plain words, or
// null when it doesn't. failed: the check the test failed, which must
// still apply after it.
// theirs: the change comes from the maker's own answer, which may change
// their own rules, schedule and answers (never what keeps it safe).
export function weakens(before: AgentDefinition, after: AgentDefinition, o: { failed?: CheckId | null; theirs?: boolean } = {}): string | null {
  const a = safetyParts(before);
  const b = safetyParts(after);
  const uses = usesOf(after);
  for (const t of a.held) if (uses.has(t) && !b.held.includes(t)) return `It would ${t === "telegram.send" ? "send you messages" : "write to your sheet"} without your yes first, which it waited for before.`;
  for (const s of a.spending) {
    const now = b.spending.find((x) => x.id === s.id);
    const still = after.actions.find((x) => x.id === s.id);
    if (still && !now) return "It would spend without counting it against your limits.";
    if (!now) continue;
    if (s.askOver !== null && (now.askOver === null || now.askOver > s.askOver)) return "It would drop or raise the limit it asks you over before spending.";
    if (s.askOverDay !== null && (now.askOverDay === null || now.askOverDay > s.askOverDay)) return "It would drop or raise the daily limit it asks you over before spending.";
  }
  if (!o.theirs) {
    if (a.rules !== b.rules) return "It would change your rules, which only you change.";
    if (a.triggers !== b.triggers) return "It would change when it runs, which only you change.";
    for (const [k, v] of Object.entries(a.given)) if (b.given[k] !== v) return "It would change an answer you gave, which only you change.";
  }
  // Model spend may rise to the floor a step asking SERV needs, no further.
  const spendRoom = after.steps.some((st) => st.kind === "code" && st.tools.includes(REASON_TOOL)) ? Math.max(a.limits.maxSpendUsd, REASONING_SPEND_FLOOR_USD) : a.limits.maxSpendUsd;
  if (b.limits.maxSpendUsd > spendRoom || b.limits.maxSteps > a.limits.maxSteps || b.limits.maxRunSeconds > a.limits.maxRunSeconds) return "It would raise the limits on what one run may do.";
  if (o.failed && !b.checks.includes(o.failed)) return "It would pass its test by making the check it failed stop applying.";
  return null;
}
