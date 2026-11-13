import "server-only";
import type { JsonResult, ModelConfig } from "../model";
import { loopsOf, type AgentDefinition, type ToolName } from "./definition";
import { storyOf, toldAs } from "./plainWords";
import { plain } from "./plainView";
import { hollow, runAgent } from "./runner";
import { runMisfits } from "./shapes";
import { goesThroughList, makeSample, sampleRequest, type Sample } from "./sample";
import type { BenchData, CheckId, RunEvent, StepCode, TestResult } from "./types";

// "Test it": the agent runs on sample data made from its own plan (one
// item, or three for an agent that goes through a list: sample.ts), every
// tool a stand-in as on the test bench, and the run is told back as a
// short story in plain words. The sample is kept with the result and made
// again only when the plan's questions or steps change.

// A short fingerprint of what the sample was made from.
export function sampleKey(d: AgentDefinition): string {
  let h = 0x811c9dc5;
  for (const ch of sampleRequest(d)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16);
}

export interface TestOptions {
  // SERV, for the sample and for live decisions; null runs dry on a plain
  // sample.
  serv: ModelConfig | null;
  // Decisions by SERV (a live run) or the bench's recorded answers.
  live: boolean;
  kind: TestResult["kind"];
  // Each model call, for the usage records.
  record?: (call: JsonResult, kind: "sample" | "decision") => Promise<void>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  // What the last sample lacked (the fixer): a new one is made with it.
  sampleNote?: string | null;
  // The maker's time zone: the test's local time.
  timeZone?: string | null;
}

export interface Tested {
  result: TestResult;
  // The sample data it ran on, for a draft's test bench.
  bench: BenchData;
  // Each step in plain words, from a sample made just now.
  plain?: Record<string, string>;
  events: RunEvent[];
  end: Extract<RunEvent, { type: "end" }>;
  // The run where the owner said no to everything it asked, when it asks.
  noRun?: RunEvent[];
}

// The sample a version's last test was made on, when it still fits.
function keptSample(d: AgentDefinition, last: TestResult | null | undefined): Sample | null {
  if (!last?.items || !last.sample || last.sampleOf !== sampleKey(d)) return null;
  return { bench: last.sample, items: last.items };
}

export async function testVersion(v: { definition: AgentDefinition; code: Record<string, StepCode>; testResult?: TestResult | null }, o: TestOptions): Promise<Tested> {
  const d = v.definition;
  let sample = o.sampleNote ? null : keptSample(d, v.testResult);
  if (!sample) {
    const made = await makeSample(d, o.serv, { signal: o.signal, fetchImpl: o.fetchImpl, note: o.sampleNote });
    if (made.call) await o.record?.(made.call, "sample");
    sample = made.sample;
  }
  const events: RunEvent[] = [];
  const end = await runAgent({
    definition: d,
    code: v.code,
    bench: sample.bench,
    dryRun: !o.live || !o.serv,
    serv: o.serv,
    signal: o.signal,
    fetchImpl: o.fetchImpl,
    onEvent: (e) => events.push(e),
    record: (call) => o.record?.(call, "decision") ?? Promise.resolve(),
    timeZone: o.timeZone,
  });
  const problems: TestResult["problems"] = [];
  const sampled = sample.items.labels.length === 1 ? `sample ${sample.items.noun}` : `sample ${sample.items.plural}`;
  if (end.status !== "done") {
    const failed = [...events].reverse().find((e): e is Extract<RunEvent, { type: "step_done" }> => e.type === "step_done" && e.status === "failed");
    const step = failed ? d.steps.find((s) => s.id === failed.stepId) : undefined;
    problems.push({ step: step?.id ?? null, text: step ? `"${step.title}" didn't work on the ${sampled}.` : `It didn't get through the ${sampled}.`, check: "ran" });
  } else {
    // A call that went wrong and was passed over: the run went on with
    // nothing, which only looks like it worked.
    const wrong = events.find((e): e is ToolEvent => e.type === "tool" && Boolean(e.error));
    const step = wrong ? d.steps.find((s) => s.id === wrong.stepId) : undefined;
    if (wrong) problems.push({ step: step?.id ?? null, text: `"${step?.title ?? "A step"}" couldn't ${TOOL_VERBS[wrong.tool] ?? "do its part"} on the ${sampled}, so it went on with nothing.`, check: "tool_error" });
  }
  const status = problems.length ? "failed" : "passed";
  const story = storyOf(d, events, end, sample.items);
  const result: TestResult = {
    status,
    // A self test's checks come after this run, so it tells its own pass.
    story: o.kind === "self" ? story : toldAs(status, story),
    problems,
    items: sample.items,
    kind: o.kind,
    checkedAt: new Date().toISOString(),
    sample: sample.bench,
    sampleOf: sampleKey(d),
  };
  return { result, bench: sample.bench, plain: sample.plain, events, end };
}

type ToolEvent = Extract<RunEvent, { type: "tool" }>;

// What each tool does, in words that follow "couldn't".
const TOOL_VERBS: Record<string, string> = {
  "sheets.read": "read your sheet",
  "sheets.write": "add to your sheet",
  "sheets.update": "write into your sheet",
  "web.fetch": "read the page",
  "web.search": "search the web",
  "telegram.send": "message you",
  "telegram.ask": "ask you",
  "memory.get": "look up where it got to",
  "memory.set": "note where it got to",
  "wallet.pay": "pay",
  "serv.reason": "ask SERV",
};
const toolEvents = (events: RunEvent[], tool: string) => events.filter((e): e is ToolEvent => e.type === "tool" && e.tool === tool && !e.error);

// How many items a run judged: in its decisions over a list, and its
// decisions inside a loop (one item a pass). A decision that only picks the
// run's way (is the order big?) judges no item.
function judged(d: AgentDefinition, events: RunEvent[]): number {
  const inLoop = loopsOf(d).inside;
  return events.reduce((n, e) => {
    if (e.type !== "step_done" || e.status !== "ok") return n;
    const verdicts = (e.output as { verdicts?: unknown } | null)?.verdicts;
    if (Array.isArray(verdicts)) return n + verdicts.length;
    return n + (e.outcome !== null && inLoop.get(e.stepId) ? 1 : 0);
  }, 0);
}

// The rows a run changed in place, as "tab:row".
function updatedRows(events: RunEvent[]): Set<string> {
  return new Set(
    toolEvents(events, "sheets.update").flatMap((e) => {
      const a = e.args as { sheet?: string; updates?: { row?: number }[] };
      return (a.updates ?? []).map((u) => `${a.sheet}:${u.row}`);
    }),
  );
}

// Whether the agent keeps track of what it has done, so a second run
// should leave it alone: it saves a place between runs, or marks the rows
// it has handled.
export function keepsPlace(d: AgentDefinition): boolean {
  const tools = new Set([...d.actions.map((a) => a.tool), ...d.steps.flatMap((s) => (s.kind === "code" ? s.tools : []))]);
  return tools.has("memory.set") || tools.has("sheets.update");
}

// The checks a self test gives an agent, by the platform's rules and the
// agent's plan alone, never by what anyone asks for one agent (a repair
// can't make a failing check stop applying: guarded.ts). Every agent: it
// runs through, and no tool error is passed over. One that sends, writes
// or pays: it does so on a sample made for it. One that goes through a list
// and sends after it: the summary covers every item. One that goes through
// a tab's rows and writes rows: not back into that tab. One that keeps its
// place: run again, it skips what it did.
export function checksFor(d: AgentDefinition): CheckId[] {
  const out: CheckId[] = ["ran", "tool_error"];
  if (d.steps.some((s) => s.kind === "code" && s.tools.some((t) => READS.includes(t)))) out.push("read_nothing");
  if (d.steps.some((s) => s.kind === "code" && s.shapes && Object.keys(s.shapes).length)) out.push("shape");
  const tools = new Set([...d.actions.map((a) => a.tool), ...d.steps.flatMap((s) => (s.kind === "code" ? s.tools : []))]);
  if (d.actions.some((a) => a.tool !== "memory.set")) out.push("did_job");
  const many = goesThroughList(d);
  const inLoop = loopsOf(d).inside;
  const sendsAfter = d.steps.some((s) => s.kind === "action" && !inLoop.get(s.id) && d.actions.find((a) => a.id === s.action)?.tool === "telegram.send");
  if (many && sendsAfter) out.push("summary");
  if (many && tools.has("sheets.read") && tools.has("sheets.write")) out.push("write_back");
  if (keepsPlace(d)) out.push("second_run");
  if (tools.has("telegram.ask") || tools.has("wallet.pay")) out.push("said_no");
  return out;
}

// The check every new plan gets once its code is written: it runs on its
// sample (sample.ts), dry (its decisions take turns over the outcomes, and
// no model is asked). It fails when that run doesn't get through. Then
// only the checks that fit the agent:
//
// - one that goes through a list and sends a summary after it: the
//   summary covers every item, not some;
// - one that goes through the rows of a tab: it doesn't add its results as
//   new rows of that same tab, where they would come back as new items;
// - one that keeps track of what it has done (a saved place, rows it
//   marks): run again on what the first run left behind, it doesn't go
//   through the same items again (judge them again, write into the same
//   rows again, or write them back into the tab they came from).
//
// An agent that watches one product, or totals today's sales, is never
// failed by a check written for one that goes through submissions.
export async function selfTest(v: { definition: AgentDefinition; code: Record<string, StepCode>; testResult?: TestResult | null }, o: Omit<TestOptions, "live" | "kind">): Promise<Tested> {
  const first = await testVersion(v, { ...o, live: false, kind: "self" });
  const told = (t: Tested): Tested => ({ ...t, result: { ...t.result, story: toldAs(t.result.status, t.result.story) } });
  if (first.result.status === "failed" || !first.result.items) return told(first);
  const d = v.definition;
  const items = first.result.items;
  const problems = [...first.result.problems];
  const checks = new Set(checksFor(d));
  const inLoop = loopsOf(d).inside;

  // Its job, done at least once on a sample made for it to work on, where
  // the owner says yes to whatever it asks: an agent that writes, sends or
  // pays and did none of it found nothing to do where there was something.
  // (Asking first is not the job; a question with no yes is not a pass.)
  const did = (tool: string) => first.events.some((e) => e.type === "tool" && !e.error && e.tool === tool);
  const jobs = d.actions.filter((a) => a.tool !== "memory.set" && a.tool !== "telegram.ask");
  const asked = d.actions.filter((a) => a.tool === "telegram.ask");
  const job = jobs.length ? (jobs.some((a) => did(a.tool)) ? null : jobs[0]!) : asked.length && !asked.some((a) => did(a.tool)) ? asked[0]! : null;
  if (job && checks.has("did_job")) {
    problems.push({ step: d.steps.find((s) => s.kind === "action" && s.action === job.id)?.id ?? null, text: `On its sample it didn't ${lowerFirst(plain(job.description)).replace(/\.$/, "")}: it found nothing to do in data made for it to work on.`, check: "did_job" });
  }

  // What passes between steps: each output in the shape its plan says.
  const misfit = checks.has("shape") ? runMisfits(d, first.events) : null;
  if (misfit) problems.push({ step: misfit.step, text: misfit.text, check: "shape" });

  // What it read: a step that reads a page, a sheet or a search and got
  // nothing back, on a sample made for it, either went on with nothing or
  // made up what it passed on. Either way it reads the wrong thing.
  if (checks.has("read_nothing")) {
    const sampled = items.labels.length === 1 ? `sample ${items.noun}` : `sample ${items.plural}`;
    for (const s of d.steps) {
      if (s.kind !== "code" || !s.tools.some((t) => READS.includes(t))) continue;
      const reads = first.events.filter((e): e is ToolEvent => e.type === "tool" && e.stepId === s.id && READS.includes(e.tool as ToolName) && !e.error);
      const ran = first.events.find((e): e is Extract<RunEvent, { type: "step_done" }> => e.type === "step_done" && e.stepId === s.id && e.status === "ok");
      if (!reads.length || !ran || !reads.every(emptyRead)) continue;
      problems.push({
        step: s.id,
        text: hollow(ran.output) ? `"${s.title}" read nothing on the ${sampled}, so it would go on with nothing.` : `"${s.title}" read nothing on the ${sampled}, yet passed something on: it would make up what it read.`,
        check: "read_nothing",
      });
      break;
    }
  }

  // The summary: the last message it sends, after going through the list.
  const sends = toolEvents(first.events, "telegram.send");
  const summary = sends.at(-1);
  if (checks.has("summary") && summary && !inLoop.get(summary.stepId)) {
    const text = String((summary.args as { text?: unknown }).text ?? "").toLowerCase();
    const named = items.labels.filter((l) => text.includes(l.toLowerCase())).length;
    // "3 submissions" counts all three; "2 of 3 met" doesn't.
    const words = [items.plural, items.noun].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const counted = new RegExp(`\\b(?:${items.labels.length}|three)\\s+(?:new\\s+)?(?:${words})\\b`).test(text);
    if (named < items.labels.length && !counted) {
      problems.push({ step: summary.stepId, text: `Its summary covers ${named === 0 ? "none" : "only some"} of the ${items.plural}, not all ${items.labels.length}.`, check: "summary" });
    }
  }

  const reads = new Set(toolEvents(first.events, "sheets.read").map((e) => String((e.args as { sheet?: unknown }).sheet)));
  const added = checks.has("write_back")
    ? toolEvents(first.events, "sheets.write").find((e) => {
        const a = e.args as { sheet?: unknown; mode?: unknown };
        return reads.has(String(a.sheet)) && a.mode !== "replace";
      })
    : undefined;
  if (added) problems.push({ step: added.stepId, text: `It adds its results as new rows of the sheet it reads ${items.plural} from, so they would come back as new ${items.plural}.`, check: "write_back" });

  if (checks.has("second_run")) {
    const many = goesThroughList(d);
    const again: RunEvent[] = [];
    await runAgent({
      definition: d,
      code: v.code,
      bench: { ...first.bench, sheets: first.end.sheets, memory: first.end.memory },
      dryRun: true,
      signal: o.signal,
      onEvent: (e) => again.push(e),
      timeZone: o.timeZone,
    });
    const before = updatedRows(first.events);
    const twice = [...updatedRows(again)].some((r) => before.has(r));
    // Rows written again into the tab the items came from, naming them.
    const labels = new RegExp(items.labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
    const rewritten = toolEvents(again, "sheets.write").some((e) => {
      const a = e.args as { sheet?: unknown; rows?: unknown };
      return reads.has(String(a.sheet)) && labels.test(JSON.stringify(a.rows ?? []));
    });
    if ((many && judged(d, again) > 0) || twice || rewritten) problems.push({ step: null, text: `Run again, it would go through the same ${items.plural} a second time: it should only take new ones.`, check: "second_run" });
  }

  // Asked, or paying: run again where the owner says no to every question
  // and every payment. After the first no, it pays nothing and sends or
  // writes nothing more.
  let noRun: RunEvent[] | undefined;
  if (checks.has("said_no")) {
    noRun = [];
    const no = { ...first.bench, telegram: { answers: first.bench.telegram.answers.map(() => "No").concat(["No", "No", "No"]) }, approve: "no" as const };
    await runAgent({ definition: d, code: v.code, bench: no, dryRun: true, signal: o.signal, onEvent: (e) => noRun!.push(e), timeZone: o.timeZone });
    const said = noRun.findIndex((e) => e.type === "tool" && ((e.tool === "telegram.ask" && /^\s*no\b/i.test(String((e.result as { answer?: unknown } | null)?.answer ?? ""))) || (e.tool === "wallet.pay" && Boolean(e.error))));
    const after = said < 0 ? undefined : noRun.slice(said + 1).find((e): e is ToolEvent => e.type === "tool" && !e.error && ["wallet.pay", "telegram.send", "sheets.write", "sheets.update"].includes(e.tool));
    if (after) problems.push({ step: after.stepId, text: `When you say no, it still ${TOOL_DID[after.tool] ?? "goes on"}.`, check: "said_no" });
  }

  return told({ ...first, noRun, result: { ...first.result, status: problems.length ? "failed" : "passed", problems } });
}

// The tools that read from outside, and a read that brought nothing back.
const READS: readonly ToolName[] = ["web.fetch", "sheets.read", "web.search"];
function emptyRead(e: ToolEvent): boolean {
  const r = (e.result ?? {}) as { status?: unknown; text?: unknown; rows?: unknown; results?: unknown };
  if (e.tool === "web.fetch") return r.status !== 200 || !String(r.text ?? "").trim();
  if (e.tool === "sheets.read") return !Array.isArray(r.rows) || r.rows.length === 0;
  return !Array.isArray(r.results) || r.results.length === 0;
}

// What a tool did, in words that follow "it still".
const TOOL_DID: Record<string, string> = { "wallet.pay": "pays", "telegram.send": "messages you", "sheets.write": "adds to your sheet", "sheets.update": "writes into your sheet" };

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
