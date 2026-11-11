import "server-only";
import type { JsonResult, ModelConfig } from "../model";
import type { AgentDefinition } from "./definition";
import { storyOf } from "./plainWords";
import { runAgent } from "./runner";
import { makeSample, sampleRequest, type Sample } from "./sample";
import type { BenchData, RunEvent, StepCode, TestResult } from "./types";

// "Test it": the agent runs on sample data made from its own plan (three
// items, sample.ts), every tool a stand-in as on the test bench, and the
// run is told back as a short story in plain words. The sample is kept with
// the result and made again only when the plan's questions or steps change.

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
}

export interface Tested {
  result: TestResult;
  // The sample data it ran on, for a draft's test bench.
  bench: BenchData;
  // Each step in plain words, from a sample made just now.
  plain?: Record<string, string>;
  events: RunEvent[];
  end: Extract<RunEvent, { type: "end" }>;
}

// The sample a version's last test was made on, when it still fits.
function keptSample(d: AgentDefinition, last: TestResult | null | undefined): Sample | null {
  if (!last?.items || !last.sample || last.sampleOf !== sampleKey(d)) return null;
  return { bench: last.sample, items: last.items };
}

export async function testVersion(v: { definition: AgentDefinition; code: Record<string, StepCode>; testResult?: TestResult | null }, o: TestOptions): Promise<Tested> {
  const d = v.definition;
  let sample = keptSample(d, v.testResult);
  if (!sample) {
    const made = await makeSample(d, o.serv, { signal: o.signal, fetchImpl: o.fetchImpl });
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
  });
  const problems: TestResult["problems"] = [];
  if (end.status !== "done") {
    const failed = [...events].reverse().find((e): e is Extract<RunEvent, { type: "step_done" }> => e.type === "step_done" && e.status === "failed");
    const step = failed ? d.steps.find((s) => s.id === failed.stepId) : undefined;
    problems.push({ step: step?.id ?? null, text: step ? `"${step.title}" didn't work on the sample ${sample.items.plural}.` : `It didn't get through the sample ${sample.items.plural}.` });
  }
  const result: TestResult = {
    status: problems.length ? "failed" : "passed",
    story: storyOf(d, events, end, sample.items),
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
const toolEvents = (events: RunEvent[], tool: string) => events.filter((e): e is ToolEvent => e.type === "tool" && e.tool === tool && !e.error);

// How many items a run judged in its decisions over a list.
function judged(events: RunEvent[]): number {
  return events.reduce((n, e) => {
    const verdicts = e.type === "step_done" && e.status === "ok" ? (e.output as { verdicts?: unknown } | null)?.verdicts : undefined;
    return n + (Array.isArray(verdicts) ? verdicts.length : 0);
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

// The check every new plan gets once its code is written: it runs on three
// sample items, dry (its decisions take turns over the outcomes, and no
// model is asked), and again on what the first run left behind. It fails
// when the first run doesn't get through, when the summary it sends
// doesn't cover all three items, when it writes its results as new rows of
// the very tab it reads, or when the second run would go through the same
// items again: judge them again, write into the same rows again, or write
// them back into the tab they came from. (An agent that orders what is
// still low on its next run, into a tab of its own, isn't going over the
// same items: it is doing its job again.)
export async function selfTest(v: { definition: AgentDefinition; code: Record<string, StepCode>; testResult?: TestResult | null }, o: Omit<TestOptions, "live" | "kind">): Promise<Tested> {
  const first = await testVersion(v, { ...o, live: false, kind: "self" });
  if (first.result.status === "failed" || !first.result.items) return first;
  const d = v.definition;
  const items = first.result.items;
  const problems = [...first.result.problems];

  const sends = toolEvents(first.events, "telegram.send");
  const summary = sends.at(-1);
  if (summary) {
    const text = String((summary.args as { text?: unknown }).text ?? "").toLowerCase();
    const named = items.labels.filter((l) => text.includes(l.toLowerCase())).length;
    // "3 submissions" counts all three; "2 of 3 met" doesn't.
    const words = [items.plural, items.noun].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const counted = new RegExp(`\\b(?:${items.labels.length}|three)\\s+(?:new\\s+)?(?:${words})\\b`).test(text);
    if (named < items.labels.length && !counted) {
      problems.push({ step: summary.stepId, text: `Its summary covers ${named === 0 ? "none" : "only some"} of the ${items.plural}, not all ${items.labels.length}.` });
    }
  }

  const reads = new Set(toolEvents(first.events, "sheets.read").map((e) => String((e.args as { sheet?: unknown }).sheet)));
  const added = toolEvents(first.events, "sheets.write").find((e) => {
    const a = e.args as { sheet?: unknown; mode?: unknown };
    return reads.has(String(a.sheet)) && a.mode !== "replace";
  });
  if (added) problems.push({ step: added.stepId, text: `It adds its results as new rows of the sheet it reads ${items.plural} from, so they would come back as new ${items.plural}.` });

  const again: RunEvent[] = [];
  await runAgent({
    definition: d,
    code: v.code,
    bench: { ...first.bench, sheets: first.end.sheets, memory: first.end.memory },
    dryRun: true,
    signal: o.signal,
    onEvent: (e) => again.push(e),
  });
  const before = updatedRows(first.events);
  const twice = [...updatedRows(again)].some((r) => before.has(r));
  // Rows written again into the tab the items came from, naming them.
  const labels = new RegExp(items.labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
  const rewritten = toolEvents(again, "sheets.write").some((e) => {
    const a = e.args as { sheet?: unknown; rows?: unknown };
    return reads.has(String(a.sheet)) && labels.test(JSON.stringify(a.rows ?? []));
  });
  if (judged(again) > 0 || twice || rewritten) problems.push({ step: null, text: `Run again, it would go through the same ${items.plural} a second time: it should only take new ones.` });

  return { ...first, result: { ...first.result, status: problems.length ? "failed" : "passed", problems } };
}
