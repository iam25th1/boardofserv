import { loopsOf, type AgentDefinition } from "./definition";
import type { RunEvent, TestResult } from "./types";

// What a maker reads about their agent when details are off: why a plan
// didn't come together, what a test did, and what is wrong now, each in a
// plain sentence or two. No step ids, tool names, JSON or step kinds: those
// stay in the details view.

// Why a plan didn't check out, from the checker's reasons (definition.ts),
// and what to add in the chat. The reasons name steps by id, so none is
// repeated: each kind of problem has its own plain words.
const FAILURES: [RegExp, string, string | null][] = [
  [/check trigger|check step/, "it tried to start when a value changes instead of on a clock", "Say how often it should run, for example every 15 minutes."],
  [/^triggers/, "it didn't say what starts it", "Say when it should run, for example every 15 minutes or every morning."],
  [/can't be reached from the first step/, "some of its steps weren't joined up to the start, so they could never run", null],
  [/which no step outputs|not every way to it makes/, "a step needed something no step before it had worked out", "Say where it finds each thing it works with."],
  [/arguments, made by a code step|which other steps read too/, "a step that writes or pays wasn't handed exactly what to write or pay", "Say what it writes and where, for example which columns of which sheet."],
  [/which is not a step|is not a declared action/, "a step pointed at something that isn't there", null],
  [/a schedule runs at most every|value check runs at most every|hourly schedule|weekly schedule/, "it asked to run on a clock it can't keep", "Say how often it should run, for example every 15 minutes or every morning."],
  [/no declared action uses it|which only reads/, "a step tried to send or write without saying so up front", "Say what it sends or writes, and to whom."],
  [/made inside the loop .* gone once its passes end/, "a step after going through the items looked at only the last one, not all of them", "Say what it should do with the results of every item, for example a summary naming each one."],
  [/reached both inside and outside a loop|starts each pass at|so ".*" must be one of its inputs|outputs the lists it gathers|gathers ".*", which no step inside it makes|calls each item/, "the steps it repeats for each item weren't joined up", "Say what it goes through one at a time, and what it keeps from each."],
  [/judges many things at once/, "it judged many things in one go instead of one at a time", "Say what is judged for each item, for example each requirement of each submission."],
  [/loops back|last time round/, "it went back to an earlier step instead of going through the items one at a time", null],
  [/decides a count|decides whether items are left/, "it used a judgement step for counting or going through a list", null],
  [/code step .* judges/, "it left a judgement to code instead of SERV", null],
  [/saves to memory without reading/, "it saved its place without looking at where it got to last time", null],
  [/reads its place from memory, but no step saves it/, "it looked up where it got to last time, but never saved where it got to", "Say how it should tell new rows from ones it has checked, for example by an empty Status column."],
  [/judges each item of/, "its judgement over a list wasn't joined up", "Say what each item is judged on, and what happens with the results."],
  [/not JSON|No model answered/, "SERV's answer came back incomplete", null],
];

export function planFailure(errors: string[]): string {
  const said = new Set<string>();
  let suggestion: string | null = null;
  for (const e of errors) {
    const hit = FAILURES.find(([pattern]) => pattern.test(e));
    if (!hit) continue;
    said.add(hit[1]);
    suggestion ??= hit[2];
  }
  const reasons = [...said].slice(0, 2);
  const why = reasons.length ? reasons.join(", and ") : "its steps didn't fit together";
  return `The plan didn't come together: ${why}. ${suggestion ?? "Add a detail in the chat, like where it finds things, what it decides, and what it writes or sends."}`;
}

// The first value of a written row that reads as a verdict ("Passed",
// "Rejected"): a status-like column if there is one, else any short word.
const VERDICT_COLUMN = /status|result|outcome|verdict|decision|state/i;

function tally(rows: Record<string, unknown>[]): string | null {
  if (!rows.length) return null;
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !c.startsWith("_"));
  const short = (v: unknown) => typeof v === "string" && v.trim() !== "" && v.trim().split(/\s+/).length <= 3;
  const column = columns.find((c) => VERDICT_COLUMN.test(c) && rows.every((r) => short(r[c]))) ?? null;
  if (!column) return null;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = String(r[column]).trim().toLowerCase();
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts].map(([v, n]) => `${n} ${v}`).join(", ");
}

// The rows a run wrote or changed in sheets, in order.
function writtenRows(events: RunEvent[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const e of events) {
    if (e.type !== "tool" || e.error) continue;
    const args = e.args as { rows?: unknown; updates?: unknown } | null;
    if (e.tool === "sheets.write" && Array.isArray(args?.rows)) rows.push(...(args.rows as Record<string, unknown>[]));
    if (e.tool === "sheets.update" && Array.isArray(args?.updates)) rows.push(...(args.updates as { values?: Record<string, unknown> }[]).map((u) => u.values ?? {}));
  }
  return rows;
}

// Text a run sent or asked, quoted short.
function quoted(v: unknown, max = 90): string {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  return `"${t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t}"`;
}

// What one tool call did, as the words of a sentence that starts "It".
function didWith(e: Extract<RunEvent, { type: "tool" }>): string | null {
  const a = (e.args ?? {}) as Record<string, unknown>;
  const r = (e.result ?? {}) as Record<string, unknown>;
  switch (e.tool) {
    case "sheets.read": {
      const n = Array.isArray(r.rows) ? r.rows.length : null;
      return n === null ? "read your sheet" : `read ${n} ${n === 1 ? "row" : "rows"} of your sheet`;
    }
    case "web.fetch":
      return r.status === 200 ? "read the page" : "tried the page, which didn't answer";
    case "web.search":
      return "searched the web";
    case "telegram.ask": {
      const answer = typeof r.answer === "string" && r.answer.trim() ? `you answered ${quoted(r.answer, 30)}` : "no answer came";
      return `asked you on Telegram ${quoted(a.question)} (${answer})`;
    }
    case "telegram.send":
      return `sent you ${quoted(a.text)} on Telegram`;
    case "sheets.update": {
      const n = Array.isArray(a.updates) ? a.updates.length : 0;
      return `wrote into ${n} ${n === 1 ? "row" : "rows"} of your sheet`;
    }
    case "sheets.write": {
      const n = Array.isArray(a.rows) ? a.rows.length : 0;
      return `added ${n} ${n === 1 ? "row" : "rows"} to your sheet`;
    }
    case "wallet.pay":
      return `paid ${typeof a.amountUsdc === "number" ? a.amountUsdc : "some"} test USDC to ${quoted(a.to, 40)}`;
    case "memory.set":
      return "noted where it got to, for next time";
    default:
      return null;
  }
}

// "a, b and c".
function joined(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// A test run as a short story of what it did. An agent that goes through a
// list counts what it did with the items: "3 submissions checked: 2
// passed, 1 rejected, summary sent." One that handles one thing says what
// it did, in order: "It read the page, asked you on Telegram "..." and you
// answered "Yes", and sent you "..." on Telegram." Or where it stopped.
export function storyOf(d: AgentDefinition, events: RunEvent[], end: Extract<RunEvent, { type: "end" }>, items: TestResult["items"]): string {
  const title = (id: string) => d.steps.find((s) => s.id === id)?.title ?? "a step";
  const tools = events.filter((e): e is Extract<RunEvent, { type: "tool" }> => e.type === "tool" && !e.error);
  const failed = [...events].reverse().find((e): e is Extract<RunEvent, { type: "step_done" }> => e.type === "step_done" && e.status === "failed");
  const at = failed ? ` at "${title(failed.stepId)}"` : "";
  // Where it stopped, after what it did, or before it did anything.
  const stopped = (did: string, before = "anything") => (did ? `${did}, then it stopped${at}.` : `It stopped${at}, before doing ${before}.`);
  const inLoop = loopsOf(d).inside;
  const many = d.steps.some((s) => s.kind === "loop" || (s.kind === "decision" && Boolean(s.each)));

  if (!many) {
    // Each thing it did, in order; and when a decision ended it with
    // nothing more to do, which way it went.
    const parts: string[] = [];
    let ended: string | null = null;
    for (const e of events) {
      if (e.type === "tool" && !e.error) {
        const said = didWith(e);
        if (said && parts.at(-1) !== said) parts.push(said);
        ended = null;
      } else if (e.type === "step_done" && e.status === "ok" && e.outcome) {
        const step = d.steps.find((s) => s.id === e.stepId);
        ended = step?.kind === "decision" ? (step.outcomes.find((o) => o.id === e.outcome)?.label ?? null) : null;
      }
    }
    if (end.status === "done" && ended) parts.push(`found ${quoted(ended.toLowerCase(), 60)}, so there was nothing more to do`);
    const did = parts.length ? `It ${joined(parts)}` : "";
    if (end.status !== "done") return stopped(did);
    return did ? `${did}.` : "It ran to the end without writing or sending anything.";
  }

  const count = (tool: string) => tools.filter((t) => t.tool === tool).length;
  const rows = writtenRows(events);
  const updated = tools.filter((t) => t.tool === "sheets.update").reduce((k, t) => k + ((t.args as { updates?: unknown[] }).updates?.length ?? 0), 0);
  const added = rows.length - updated;
  const parts: string[] = [];
  const verdicts = tally(rows);
  if (verdicts) parts.push(verdicts);
  else if (added) parts.push(`${added} ${added === 1 ? "row" : "rows"} written`);
  const summary = d.actions.some((a) => a.tool === "telegram.send" && /summary|report|digest|recap|round.?up/i.test(a.description));
  const sent = count("telegram.send");
  if (sent) parts.push(summary ? "summary sent" : sent === 1 ? "message sent" : `${sent} messages sent`);
  const asked = count("telegram.ask");
  if (asked) parts.push(asked === 1 ? "asked you once" : `asked you ${asked} times`);
  const paid = count("wallet.pay");
  if (paid) parts.push(paid === 1 ? "1 payment made" : `${paid} payments made`);

  const n = items?.labels.length ?? 0;
  // Items judged: by decisions over a list, or one a pass inside a loop.
  const judged = events.reduce((k, e) => {
    if (e.type !== "step_done" || e.status !== "ok") return k;
    const v = (e.output as { verdicts?: unknown } | null)?.verdicts;
    return k + (Array.isArray(v) ? v.length : e.outcome !== null && inLoop.get(e.stepId) ? 1 : 0);
  }, 0);
  const did = Boolean(items && n && (updated || judged));
  const head = !items || !n ? "It ran" : updated ? `${updated} ${updated === 1 ? items.noun : items.plural} checked` : judged ? `${n} ${items.plural} judged` : `${n} sample ${items.plural}`;
  if (end.status !== "done") {
    if (did) return stopped(`${head}${parts.length ? ` (${parts.join(", ")})` : ""}`);
    return stopped("", items && n ? `anything with the ${n} sample ${items.plural}` : "anything");
  }
  if (!parts.length) return head === "It ran" ? "It ran to the end without writing or sending anything." : `${head}, nothing written or sent.`;
  return `${head}: ${parts.join(", ")}.`;
}

// A test's story as the maker reads it: a pass says so first.
export function toldAs(status: TestResult["status"], story: string): string {
  return status === "passed" ? `Passed. ${story}` : story;
}

export interface Problem {
  text: string;
  // The step it is about, by id (never shown), when there is one.
  step: string | null;
  // How "Fix this" fixes it: SERV writes a held step's code again, or
  // changes the plan from the problem's own words.
  fix: "rewrite" | "replan" | "plan";
}

// What is wrong with a version now, as the one sentence a maker sees first,
// or null when nothing is.
export function problemOf(v: {
  definition: AgentDefinition | null;
  code: Record<string, { status: string }>;
  buildState: string;
  buildNote: string | null;
  testResult?: TestResult | null;
  review?: { status: string; findings: { finding: string; severity: string }[] } | null;
}): Problem | null {
  if (v.buildState === "failed") return { text: v.buildNote ?? "The plan didn't come together.", step: null, fix: v.definition ? "replan" : "plan" };
  if (["planning", "writing", "fixing"].includes(v.buildState) || !v.definition) return null;
  const held = v.definition.steps.find((s) => s.kind === "code" && v.code[s.id]?.status === "needs_attention");
  if (held) return { text: `"${held.title}" didn't pass SERV's check of its code, so it's on hold.`, step: held.id, fix: "rewrite" };
  const blocking = v.review?.status === "blocked" ? v.review.findings.find((f) => f.severity === "blocking") : undefined;
  if (blocking) return { text: blocking.finding, step: null, fix: "replan" };
  const failed = v.testResult?.status === "failed" ? v.testResult.problems[0] : undefined;
  if (failed) return { text: failed.text, step: failed.step, fix: "replan" };
  return null;
}
