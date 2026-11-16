import type { AgentDefinition, CodeStepDef } from "./definition";
import type { FixVerdict } from "./fixer";
import { OUTSIDE_TOOLS } from "./toolbox";
import { stepLine, stepsInOrder } from "./plainView";
import { emptyHeal, type Diagnosis, type HealLog, type HealRound } from "./types";

// The heal log's bookkeeping, and the plain words a build says while it
// heals: what the Build and Try it cards show, one calm line at a time
// ("Found a problem in step 1. Fixing it.", then "Fixed."), and the one
// sentence it ends with when it gives up. No model, no database: build.ts
// runs the rounds (fixer.ts says what to do in each).

// How far one build may go healing itself: repair rounds, and what all of
// its model calls may cost, which grows with the agent's size. Both can be
// set (AGENT_HEAL_ROUNDS, AGENT_BUILD_COST_USD).
export function healLimits(d: Pick<AgentDefinition, "steps"> | null, env: Record<string, string | undefined> = process.env): { rounds: number; costUsd: number } {
  const r = Number(env.AGENT_HEAL_ROUNDS);
  const c = Number(env.AGENT_BUILD_COST_USD);
  const steps = d?.steps.length ?? 8;
  return {
    rounds: env.AGENT_HEAL_ROUNDS?.trim() && Number.isInteger(r) && r >= 0 ? r : 3,
    costUsd: env.AGENT_BUILD_COST_USD?.trim() && Number.isFinite(c) && c > 0 ? c : Math.round((0.3 + 0.03 * steps) * 100) / 100,
  };
}

// A new build starts a fresh page of the log: its lines, question and
// giving up are this build's alone; every round before stays, for the
// details view.
export function freshBuild(log: HealLog | null | undefined): HealLog {
  const l = log ?? emptyHeal();
  return { ...l, lines: [], question: null, gaveUp: null, since: l.rounds.length, costUsd: 0 };
}

// The rounds this build has acted on (a diagnosis waiting is not one yet).
export function roundsUsed(log: HealLog | null | undefined): number {
  if (!log) return 0;
  return log.rounds.slice(log.since ?? 0).filter((r) => r.verdict !== null).length;
}

export function withLine(log: HealLog, text: string, tone: HealLog["lines"][number]["tone"]): HealLog {
  return { ...log, lines: [...log.lines, { text, tone, at: new Date().toISOString() }] };
}

// The round being acted on: the last one, filled in as it goes.
export function withRound(log: HealLog, patch: Partial<HealRound>): HealLog {
  const rounds = [...log.rounds];
  const last = rounds.at(-1);
  if (!last) return log;
  rounds[rounds.length - 1] = { ...last, ...patch };
  return { ...log, rounds };
}

// A step's number as the maker sees it: its place in the steps' order.
export function stepNumber(d: AgentDefinition | null, id: string | null | undefined): number | null {
  if (!d || !id) return null;
  const i = stepsInOrder(d).findIndex((s) => s.id === id);
  return i >= 0 ? i + 1 : null;
}

const quote = (t: string) => `"${t.replace(/\.$/, "")}"`;

// The line that says a round starts.
export function foundLine(dx: Diagnosis, d: AgentDefinition | null): string {
  const n = stepNumber(d, dx.step?.id);
  if (dx.stage === "plan") return "Found a problem in the steps. Fixing it.";
  if (dx.stage === "test") return n ? `Found a problem in step ${n} while trying it. Fixing it.` : "Found a problem while trying it. Fixing it.";
  if (dx.stage === "live") return n ? `Found a problem in step ${n} before it goes live. Fixing it.` : "Found a problem before it goes live. Fixing it.";
  return n ? `Found a problem in step ${n}. Fixing it.` : "Found a problem in a step. Fixing it.";
}

// What the round is doing, once the fixer has said.
export function repairLine(verdict: "code" | "plan" | "test", d: AgentDefinition | null, stepId: string | null): string {
  const n = stepNumber(d, stepId);
  if (verdict === "code") return n ? `Writing step ${n} again.` : "Writing a step again.";
  if (verdict === "test") return "Making a better sample to try it on.";
  return "Changing its steps.";
}

// What it couldn't do, in one plain sentence, when it gives up.
export function gaveUpLine(dx: Diagnosis, d: AgentDefinition | null): string {
  const step = d && dx.step ? d.steps.find((s) => s.id === dx.step!.id) : undefined;
  const which = step && d ? `step ${stepNumber(d, step.id)}, ${quote(stepLine(step, d))},` : "one of its steps";
  if (dx.stage === "plan") return "I couldn't work out steps that fit together for this job.";
  if (dx.stage === "live") return "I couldn't get it past the check every agent gets before it goes live.";
  if (dx.stage === "code") return `I couldn't get ${which} to work.`;
  switch (dx.evidence.check) {
    case "did_job":
      return "I couldn't get it to do its job on a sample made for it.";
    case "summary":
      return "I couldn't get its summary to cover every item.";
    case "second_run":
      return "I couldn't get it to leave what it already did alone the next time it runs.";
    case "said_no":
      return "I couldn't get it to stop when you say no.";
    case "write_back":
      return "I couldn't get it to write each result into the row it belongs to.";
    default:
      return `I couldn't get ${which} to work on its sample.`;
  }
}

// What a sample and the code's real calls not matching sounds like, in the
// fixer's words: the calls (addresses, repositories, API calls) and that
// they differ (don't match, keyed by others, written into the code, not
// mocked). A sample that is wrong in itself (a price above the target, an
// address that isn't one) is no mismatch.
const CALLS = /\b(?:urls?|address(?:es)?|endpoints?|repositor(?:y|ies)|api calls?|requests?)\b/i;
const DIFFER = /\b(?:match(?:es|ing)?|mismatch(?:es|ed)?|keyed|hard-?coded|(?:aren't|isn't|not) mocked|actual (?:urls?|address|repositor(?:y|ies)|endpoints?)|other (?:urls?|address(?:es)?)|different)\b|\bdo(?:es)?n't match\b/i;
const mismatch = (text: string) => CALLS.test(text) && DIFFER.test(text);

// The step that reads from outside: the one named, when it does, else the
// first code step that does.
export function readingStep(d: AgentDefinition, id: string | null): CodeStepDef | null {
  const reads = (s: AgentDefinition["steps"][number]): s is CodeStepDef => s.kind === "code" && s.tools.some((t) => t !== "memory.get" && (OUTSIDE_TOOLS as readonly string[]).includes(t));
  const named = d.steps.find((s) => s.id === id);
  return (named && reads(named) ? named : d.steps.find(reads)) ?? null;
}

// A new sample for a mismatch between the sample and the code's real calls
// (its addresses, its repositories), named by the fixer a second time on
// this build, is no answer: the sample is keyed by the code's own calls
// already (sample.ts), so the code or its settings are at fault. The
// reading step is written again to make its calls from the settings; when
// the fixer says what it reads must be a setting, the steps get one.
export function escalated(verdict: FixVerdict, rounds: HealRound[], d: AgentDefinition, failedAt: string | null): FixVerdict {
  if (verdict.verdict !== "test_wrong" || !mismatch(`${verdict.why} ${verdict.sample}`)) return verdict;
  if (!rounds.some((r) => r.verdict === "test" && mismatch(`${r.why} ${r.repair}`))) return verdict;
  const reading = readingStep(d, verdict.step ?? failedAt);
  const said = (verdict.sample || verdict.why).trim();
  if (/\bsettings?\b/i.test(`${verdict.why} ${verdict.sample}`) || !reading) {
    return { ...verdict, verdict: "plan_wrong", change: `${said} What it reads (which repositories, pages, forms) is a setting the reading step reads${reading ? ` ("${reading.id}" lists "settings" in its inputs)` : ""}, so its calls come from what the owner answers, never from values in the code.`.slice(0, 1200) };
  }
  return { ...verdict, verdict: "code_wrong", step: reading.id, spec: `${reading.description} Make every address and call from input.settings, exactly as given, never from a value written into the code.`.slice(0, 800) };
}
