import "server-only";
import { completeJson, type ChatMessage, type JsonResult, type ModelConfig } from "../model";
import { ANSWER_LIMITS } from "../modelLimits";
import { payeeSetting, type AgentDefinition } from "./definition";
import { emptyBench, type BenchData, type TestResult } from "./types";

// Sample data for "Test it", made from the plan: what a renter would answer
// at setup, and the items for the agent to work through, so a maker never
// types JSON to see it run. An agent that goes through a list (a loop, or
// a judgement over a list) gets three items, different from each other;
// one that handles one thing (one product page, one message) gets that one
// thing. SERV writes it from the plan in one call; without SERV, or when
// its answer doesn't fit, a plain stand-in is made from the plan's own
// questions.
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
    labels: strings("the items' own names, exactly as they appear in the data below"),
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

// How many items the sample has: three for an agent that goes through a
// list, one for an agent that handles one thing.
export function sampleCount(d: Pick<AgentDefinition, "steps">): 1 | 3 {
  return goesThroughList(d) ? 3 : 1;
}

// Whether the agent goes through a list of items: a loop over one, or a
// judgement over a list.
export function goesThroughList(d: Pick<AgentDefinition, "steps">): boolean {
  return d.steps.some((s) => s.kind === "loop" || (s.kind === "decision" && Boolean(s.each)));
}

export function samplePrompt(count: 1 | 3): string {
  return [
    "You make sample data to test an automated agent, the way its maker would try it the first time. Answer with JSON in the given schema.",
    count === 3
      ? "It goes through a list: give exactly three items for it to work through (three rows of the tab it reads, three enquiries, three submissions), realistic and different from each other: where the agent judges or filters, make one that should clearly pass and one that should clearly fail."
      : "It handles one thing each run: give exactly one item (the one product, the one message), realistic, the kind the maker would watch for: where it compares against a target or threshold, make it one that meets it. A tab it reads still has the rows its job needs (the day's sales to add up).",
    `Answer every setting, with values that fit together (a target the item meets, a page address the pages below use). A sheet setting's answer is a tab name: give that tab with the columns the steps name${count === 3 ? " and the three items as rows" : ""}. Leave empty the columns the agent itself fills in (a status or result it writes).`,
    'Give pages or search results only if a step fetches or searches. Answers only if it asks its owner something: then answer as the owner who says yes ("Yes"), one answer for every question it asks.',
    "Where it pays someone, the payee's name is exactly the one the plan pays.",
    "Also say what every step does in one plain sentence a first-time maker understands, with no names of values or tools.",
    "Never use em dashes.",
  ].join("\n");
}

// The columns its steps name, by their header names ("the Quantity and
// Minimum columns", "an Amount column", "the \"Priority\" column").
export function namedColumns(d: AgentDefinition): string[] {
  const text = d.steps.map((s) => (s.kind === "code" ? s.description : s.kind === "decision" ? s.prompt : "")).join(" ");
  const out = new Set<string>();
  const word = "[A-Z][A-Za-z0-9_]*(?: [A-Z][A-Za-z0-9_]*)?";
  for (const m of text.matchAll(new RegExp(`"(${word})" columns?`, "g"))) out.add(m[1]!);
  for (const m of text.matchAll(new RegExp(`\\b(${word}) columns?\\b`, "g"))) out.add(m[1]!);
  for (const m of text.matchAll(new RegExp(`\\bcolumns?:? ((?:"?${word}"?(?:, | and | or ))*"?${word}"?)`, "g"))) for (const c of m[1]!.split(/, | and | or /)) out.add(c.replace(/"/g, ""));
  return [...out].filter((c) => !/^(?:The|A|An|Each|Every|Its|Their|This|That|Which|Column|Columns)$/.test(c)).slice(0, 12);
}

// The plan, as the sample's prompt needs it: what it does, what it asks at setup
// and what each step does. No code.
export function sampleRequest(d: AgentDefinition): string {
  const columns = namedColumns(d);
  const payee = payeeSetting(d);
  return [
    `Agent: ${d.name}`,
    `It does: ${d.job.does}`,
    "",
    "Settings:",
    ...(d.settings.length ? d.settings.map((s) => `- ${s.key} (${s.type}${s.choices.length ? `: ${s.choices.join(", ")}` : ""}): ${s.label}`) : ["- (none)"]),
    "",
    "Steps:",
    ...d.steps.map((s) => `- ${s.id} (${s.title}): ${s.kind === "code" ? s.description : s.kind === "decision" ? s.prompt : s.kind === "loop" ? `for each item of ${s.over}` : (d.actions.find((a) => a.id === s.action)?.description ?? "")}`),
    ...(columns.length ? ["", `The steps name these columns: ${columns.join(", ")}. A tab it reads has every one of them.`] : []),
    ...(payee ? ["", `It pays the payee named in ${payee.key}${payee.given ? `: "${payee.given}", exactly` : ""}.`] : []),
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
  const count = sampleCount(d);
  const labels = texts(w.labels).slice(0, count);
  const noun = text(w.noun, 40).toLowerCase();
  if (labels.length !== count || !noun) return null;
  const plain = Object.fromEntries((w.steps ?? []).flatMap((x) => (d.steps.some((st) => st.id === text(x.id, 40)) && text(x.plain, 200) ? [[text(x.id, 40), text(x.plain, 200)]] : [])));
  return { bench, items: { noun, plural: text(w.plural, 40).toLowerCase() || `${noun}s`, labels }, plain };
}

// Without SERV: every setting answered from its own words, every sheet
// setting a tab of plain rows, one for each item.
export function plainSample(d: AgentDefinition): Sample {
  const bench = emptyBench();
  const labels = ["Sample one", "Sample two", "Sample three"].slice(0, sampleCount(d));
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

// note: what an earlier sample lacked, from the fixer (fixer.ts), for the
// new one to have.
// The sample made to fit the platform's rules for the agent it tries,
// whatever SERV gave: a question of its own gets a yes (the self test's
// second run is where the owner says no); an agent that pays has its payee
// saved by the name it pays and enough allowance; and every tab it reads
// has the columns its steps name.
export function fitSample(d: AgentDefinition, sample: Sample): Sample {
  const bench = structuredClone(sample.bench);
  const tools = new Set([...d.actions.map((a) => a.tool), ...d.steps.flatMap((s) => (s.kind === "code" ? s.tools : []))]);
  if (tools.has("telegram.ask")) {
    const yes = bench.telegram.answers.map((a) => (/^\s*(?:no|n|nope|decline|cancel|stop)\b/i.test(a) || !a.trim() ? "Yes" : a));
    bench.telegram.answers = [...yes, ...Array.from({ length: Math.max(0, 5 - yes.length) }, () => "Yes")];
  }
  if (tools.has("wallet.pay")) {
    const payee = payeeSetting(d);
    const name = payee ? (payee.given?.trim() || String(bench.settings[payee.key] ?? "").trim() || "Supplier") : "";
    if (payee) bench.settings[payee.key] = name;
    if (name) bench.payees = [name];
    bench.wallet.balanceUsdc = Math.max(bench.wallet.balanceUsdc, 1000);
  }
  // Every page it reads has text: the page a url setting names, or an
  // address its steps fetch, takes a page the sample gave when it has none.
  const pages = Object.values(bench.pages);
  if (pages.length) {
    const urls = [
      ...d.settings.filter((s) => s.type === "url").map((s) => String(bench.settings[s.key] ?? "")),
      ...d.steps.flatMap((s) => (s.kind === "code" ? (s.description.match(/https?:\/\/[^\s"'<>)]+/g) ?? []) : [])).map((u) => u.replace(/[.,;:]+$/, "")),
    ].filter((u) => /^https?:\/\//.test(u));
    for (const u of urls) bench.pages[u] ??= pages[0]!;
  }
  // A sheet setting's answer is a tab the sample has (as it is for real: a
  // tab the renter picked), never an id or a link that names none of them:
  // the tab most like the setting, else the only one, else one of its own.
  const tabs = Object.keys(bench.sheets);
  for (const st of d.settings.filter((x) => x.type === "sheet")) {
    const said = String(bench.settings[st.key] ?? "");
    if (tabs.includes(said)) continue;
    const words = `${st.key.replace(/_/g, " ")} ${st.label}`.toLowerCase();
    const like = tabs.find((t) => words.includes(t.toLowerCase()) || t.toLowerCase().split(/\s+/).some((w) => w.length > 3 && words.includes(w.replace(/s$/, ""))));
    const tab = like ?? (tabs.length === 1 ? tabs[0]! : null);
    if (tab) bench.settings[st.key] = tab;
    else {
      const own = st.label.replace(/[^\w\s-]/g, "").trim().slice(0, 40) || "Sheet";
      bench.settings[st.key] = own;
      bench.sheets[own] ??= [];
    }
  }
  const columns = namedColumns(d);
  if (columns.length) {
    for (const [tab, rows] of Object.entries(bench.sheets)) {
      const have = new Set(rows.flatMap((r) => Object.keys(r)).map((c) => c.toLowerCase()));
      const missing = columns.filter((c) => !have.has(c.toLowerCase()));
      if (missing.length && rows.length) bench.sheets[tab] = rows.map((r) => ({ ...r, ...Object.fromEntries(missing.map((c) => [c, ""])) }));
    }
  }
  return { ...sample, bench };
}

export async function makeSample(d: AgentDefinition, serv: ModelConfig | null, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; note?: string | null } = {}): Promise<{ sample: Sample; call: JsonResult | null }> {
  if (!serv) return { sample: fitSample(d, plainSample(d)), call: null };
  // Today's date rides along (not in the fingerprint): an agent that works
  // on today's rows needs rows dated today.
  const messages: ChatMessage[] = [
    { role: "system", content: samplePrompt(sampleCount(d)) },
    { role: "user", content: `${sampleRequest(d)}\n\nToday is ${new Date().toISOString().slice(0, 10)}: date the sample's rows from today where the job looks at dates.${opts.note ? `\n\nAn earlier sample didn't fit this agent: ${opts.note} Make this one fit it.` : ""}` },
  ];
  const config = { ...serv, firstTokenTimeoutMs: Math.max(serv.firstTokenTimeoutMs, 60_000) };
  const call = await completeJson(messages, { config, purpose: "agent_sample", schema: SAMPLE_SCHEMA, maxTokens: ANSWER_LIMITS.agent_sample, signal: opts.signal ?? new AbortController().signal, fetchImpl: opts.fetchImpl });
  return { sample: fitSample(d, readSample(d, call.content) ?? plainSample(d)), call };
}
