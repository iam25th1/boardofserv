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
  events: RunEvent[];
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
  return { result, bench: sample.bench, events };
}
