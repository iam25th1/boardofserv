import "server-only";
import { completeJson, type ChatMessage, type JsonResult, type ModelConfig } from "../model";
import { ANSWER_LIMITS } from "../modelLimits";
import type { AgentDefinition } from "./definition";
import { emptyBench, type BenchData, type TestResult } from "./types";

// Sample data for "Test it", made from the plan: what a renter would answer
// at setup, and three items for the agent to work through (three rows of
// the sheet it reads, say), so a maker never types JSON to see it run. SERV
// writes it from the plan in one call; without SERV, or when its answer
// doesn't fit, a plain stand-in is made from the plan's own questions.
//
// The schema is flat lists, as SERV's strict json_schema needs: no records
// with keys of its own choosing, so each setting, tab and row is an object.

const str = (description: string) => ({ type: "string", description });
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const list = (item: ReturnType<typeof obj>, description: string) => ({ type: "array", items: item, description });

export const SAMPLE_SCHEMA = {
  name: "agent_sample",
  schema: obj({
    noun: str("what one of the items it works through is called, singular, plain: submission, enquiry, product"),
    plural: str("the same, plural"),
    labels: strings("the three items' own names, exactly as they appear in the data below"),
    settings: list(obj({ key: str("a setting's key"), value: str("the renter's answer, as text") }), "an answer for every setting"),
    sheets: list(
      obj({ sheet: str("the tab's name, as a sheet setting's answer names it"), columns: strings("its columns, in order"), rows: list(obj({ cells: strings("one row's values, in column order") }), "its rows") }),
      "every tab it reads",
    ),
    pages: list(obj({ url: str("an address it fetches"), text: str("the page's readable text") }), "pages it fetches, else []"),
    searches: list(obj({ query: str('what it searches for, or "*" for anything'), title: str("result title"), url: str("result address"), snippet: str("result text") }), "search results, else []"),
    answers: strings("what the owner answers its questions, in order, else []"),
    steps: list(obj({ id: str("a step's id"), plain: str("the step in one sentence for someone who never saw code, with no names of values or tools") }), "every step, in plain words"),
  }),
};

export const SAMPLE_PROMPT = [
  "You make sample data to test an automated agent, the way its maker would try it the first time. Answer with JSON in the given schema.",
  "Give exactly three items for it to work through (three rows of the tab it reads, three enquiries, three products), realistic and different from each other: where the agent judges or filters, make one that should clearly pass and one that should clearly fail.",
  "Answer every setting. A sheet setting's answer is a tab name: give that tab with the columns the steps name and the three items as rows. Leave empty the columns the agent itself fills in (a status or result it writes).",
  "Give pages or search results only if a step fetches or searches. Answers only if it asks its owner something.",
  "Also say what every step does in one plain sentence a first-time maker understands, with no names of values or tools.",
  "Never use em dashes.",
].join("\n");

// The plan, as SAMPLE_PROMPT needs it: what it does, what it asks at setup
// and what each step does. No code.
export function sampleRequest(d: AgentDefinition): string {
  return [
    `Agent: ${d.name}`,
    `It does: ${d.job.does}`,
    "",
    "Settings:",
    ...(d.settings.length ? d.settings.map((s) => `- ${s.key} (${s.type}${s.choices.length ? `: ${s.choices.join(", ")}` : ""}): ${s.label}`) : ["- (none)"]),
    "",
    "Steps:",
    ...d.steps.map((s) => `- ${s.id} (${s.title}): ${s.kind === "code" ? s.description : s.kind === "decision" ? s.prompt : s.kind === "loop" ? `for each item of ${s.over}` : (d.actions.find((a) => a.id === s.action)?.description ?? "")}`),
  ].join("\n");
}

type Wire = {
  noun?: unknown;
  plural?: unknown;
  labels?: unknown;
  settings?: { key?: unknown; value?: unknown }[];
  sheets?: { sheet?: unknown; columns?: unknown; rows?: { cells?: unknown }[] }[];
  pages?: { url?: unknown; text?: unknown }[];
  searches?: { query?: unknown; title?: unknown; url?: unknown; snippet?: unknown }[];
  answers?: unknown;
  steps?: { id?: unknown; plain?: unknown }[];
};
const text = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const texts = (v: unknown) => (Array.isArray(v) ? v.map((x) => text(x)).filter(Boolean) : []);

// A setting's answer, typed as the setting is.
function answer(type: AgentDefinition["settings"][number]["type"], value: string): unknown {
  if (type === "number") return Number.isFinite(Number(value)) ? Number(value) : 1;
  if (type === "boolean") return /^(true|yes|1)$/i.test(value);
  if (type === "list") return value.split(",").map((x) => x.trim()).filter(Boolean);
  return value;
}

export interface Sample {
  bench: BenchData;
  items: NonNullable<TestResult["items"]>;
  // Each step in one plain sentence, by step id, when SERV gave them.
  plain?: Record<string, string>;
}

// SERV's answer as the bench's sample data, or null when it doesn't fit.
export function readSample(d: AgentDefinition, content: string | null): Sample | null {
  let w: Wire;
  try {
    w = JSON.parse(content ?? "") as Wire;
  } catch {
    return null;
  }
  const bench = emptyBench();
  const given = new Map((w.settings ?? []).map((s) => [text(s.key, 40), text(s.value, 500)]));
  for (const s of d.settings) bench.settings[s.key] = answer(s.type, given.get(s.key) || s.choices[0] || "sample");
  for (const tab of w.sheets ?? []) {
    const name = text(tab.sheet, 80);
    const columns = texts(tab.columns).map((c) => c.slice(0, 80));
    if (!name || !columns.length) continue;
    bench.sheets[name] = (tab.rows ?? []).slice(0, 20).map((r) => Object.fromEntries(columns.map((c, i) => [c, texts(r.cells)[i] ?? ""])));
  }
  for (const p of w.pages ?? []) if (text(p.url)) bench.pages[text(p.url)] = text(p.text, 50_000);
  for (const r of w.searches ?? []) {
    const q = text(r.query, 300) || "*";
    (bench.search[q] ??= []).push({ title: text(r.title, 300), url: text(r.url), snippet: text(r.snippet) });
  }
  bench.telegram.answers = texts(w.answers).slice(0, 20);
  for (const rule of d.rules) bench.rules[rule.key] = rule.value;
  const labels = texts(w.labels).slice(0, 3);
  const noun = text(w.noun, 40).toLowerCase();
  if (labels.length !== 3 || !noun) return null;
  const plain = Object.fromEntries((w.steps ?? []).flatMap((x) => (d.steps.some((st) => st.id === text(x.id, 40)) && text(x.plain, 200) ? [[text(x.id, 40), text(x.plain, 200)]] : [])));
  return { bench, items: { noun, plural: text(w.plural, 40).toLowerCase() || `${noun}s`, labels }, plain };
}

// Without SERV: every setting answered from its own words, every sheet
// setting a tab of three plain rows.
export function plainSample(d: AgentDefinition): Sample {
  const bench = emptyBench();
  const labels = ["Sample one", "Sample two", "Sample three"];
  for (const s of d.settings) {
    if (s.type === "sheet") {
      const tab = s.label.replace(/[^\w\s-]/g, "").trim().slice(0, 40) || "Sheet";
      bench.settings[s.key] = tab;
      bench.sheets[tab] = labels.map((name) => ({ Name: name }));
    } else bench.settings[s.key] = answer(s.type, s.choices[0] ?? (s.type === "number" ? "1" : "sample"));
  }
  for (const rule of d.rules) bench.rules[rule.key] = rule.value;
  return { bench, items: { noun: "item", plural: "items", labels } };
}

export async function makeSample(d: AgentDefinition, serv: ModelConfig | null, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<{ sample: Sample; call: JsonResult | null }> {
  if (!serv) return { sample: plainSample(d), call: null };
  const messages: ChatMessage[] = [
    { role: "system", content: SAMPLE_PROMPT },
    { role: "user", content: sampleRequest(d) },
  ];
  const config = { ...serv, firstTokenTimeoutMs: Math.max(serv.firstTokenTimeoutMs, 60_000) };
  const call = await completeJson(messages, { config, purpose: "agent_sample", schema: SAMPLE_SCHEMA, maxTokens: ANSWER_LIMITS.agent_sample, signal: opts.signal ?? new AbortController().signal, fetchImpl: opts.fetchImpl });
  return { sample: readSample(d, call.content) ?? plainSample(d), call };
}
