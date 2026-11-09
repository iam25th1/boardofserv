// Builds the market's two other example agents through the real pipeline,
// as scripts/seed-restock.ts builds the restock one:
//
//   1. SERV plans it from a fixed interview (planAgent, checked, up to
//      three tries),
//   2. Dolphin writes each code step and SERV reviews it (writeStep),
//   3. when it has decisions, one live run on the test bench lets SERV make
//      each, and the answers are recorded so dry runs replay them.
//
//   SEED_EXAMPLE=sheet-report    a morning summary of a sheet, on Telegram
//   SEED_EXAMPLE=lead-followup   every 15 minutes, drafts a reply to the
//                                oldest new enquiry in a sheet and asks
//                                before recording it as ready
//
// It writes src/lib/agents/examples/<example>.json and touches no database
// (scripts/import-examples.ts puts the examples on the board). It needs
// SERV_API_KEY and DOLPHIN_API_KEY in its environment, and stops before
// more model calls than SEED_SERV_BUDGET and SEED_DOLPHIN_BUDGET allow
// (12 and 8 by default). Every call is listed at the end with its status,
// tokens and time, never a key. SEED_RESUME=1 keeps a saved example's plan
// and approved code and writes only what is missing; SEED_PLAN_FROM reads
// SERV's plan answers kept by an earlier run (SEED_PLAN_OUT) again; with
// SEED_RESUME=1, SEED_FIX="what went wrong" has SERV change the saved plan
// first, and only the code steps whose job changed are written again.
//
//   SEED_EXAMPLE=sheet-report npx vite-node --config vitest.config.ts scripts/seed-examples.ts

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { servOnly } from "@/lib/agents/build";
import { dolphinProvider, writeStep } from "@/lib/agents/code";
import { checkDefinition, codeSpec, type AgentDefinition, type CodeStepDef } from "@/lib/agents/definition";
import { planAgent, wireToDefinition } from "@/lib/agents/plan";
import { runAgent } from "@/lib/agents/runner";
import type { BenchData, RunEvent, StepCode } from "@/lib/agents/types";
import { modelConfig, type ChatMessage } from "@/lib/model";
import type { SketchDTO } from "@/lib/types";

const BUDGET = { serv: Number(process.env.SEED_SERV_BUDGET ?? 12), dolphin: Number(process.env.SEED_DOLPHIN_BUDGET ?? 8) };
const MAX_CODE_STEPS = Math.min(4, BUDGET.dolphin);

interface Example {
  interview: SketchDTO;
  history: ChatMessage[];
  sheets: BenchData["sheets"];
  memory: BenchData["memory"];
  answers: string[];
  // A setting's sample answer, from its key.
  setting: (key: string, type: string) => unknown;
}

const blank = { watches: null, when: null, how: null, tells: null, takes: null, does: null, gives: null, asking: null, live: false } as const;

const EXAMPLES: Record<string, Example> = {
  "sheet-report": {
    interview: {
      ...blank,
      name: "Morning sheet report",
      kind: "agent",
      wakes: "every morning at 07:30",
      looks: "one sheet tab the owner picks, with any columns, and what it remembered yesterday: the row count and the total of each number column",
      handles:
        "work out what changed since yesterday: how many rows there are now and how many were added, and for each number column today's total and its change from yesterday; write it as a short plain message of a few lines",
      finish: "the owner got one short summary on Telegram, and today's row count and totals are remembered for tomorrow",
      asks: "nothing: it only reads the sheet and messages the owner, and never changes the sheet",
      setup: "the sheet tab to summarise",
      remembers: "yesterday's row count and column totals, as a record { rows, totals }",
    },
    history: [
      { role: "user", content: "I keep my shop's daily sales in a Google Sheet. Every morning I'd like a short message on Telegram saying what changed since yesterday." },
      { role: "assistant", content: "Anything it must never do?" },
      { role: "user", content: "Never change the sheet. Keep it to a few steps." },
    ],
    sheets: {
      Sales: [
        { date: "2026-11-10", item: "Linen tote", qty: 3, total_usdc: 54 },
        { date: "2026-11-10", item: "Canvas apron", qty: 1, total_usdc: 28 },
        { date: "2026-11-11", item: "Linen tote", qty: 2, total_usdc: 36 },
        { date: "2026-11-11", item: "Wool scarf", qty: 4, total_usdc: 96 },
      ],
    },
    memory: { last: { rows: 2, totals: { qty: 4, total_usdc: 82 } } },
    answers: [],
    setting: (key, type) => (type === "sheet" || /sheet|tab/i.test(key) ? "Sales" : type === "number" ? 0 : ""),
  },
  "lead-followup": {
    interview: {
      ...blank,
      name: "Enquiry follow-up",
      kind: "agent",
      wakes: "every 15 minutes",
      looks: "the Enquiries sheet (columns name, contact, interest, message) and the Replies sheet; an enquiry is new when its contact isn't in the Replies sheet yet",
      handles:
        "take the oldest new enquiry, if there is one, and draft a short friendly reply from the owner's reply template, filling in the person's name and what they asked about; then ask the owner on Telegram, showing the draft, whether to use it",
      finish:
        "the oldest new enquiry has a row in the Replies sheet (name, contact, reply, status): status ready to send when the owner said yes, skipped when they said no; with no new enquiry, nothing happens",
      asks: "never record a reply as ready to send without asking the owner on Telegram first and showing them the draft",
      setup: "the Enquiries sheet and the Replies sheet (each picked as a Google Sheet tab), the business name and the reply template",
      remembers: "nothing",
    },
    history: [
      { role: "user", content: "People send enquiries through a form that fills a Google Sheet. I want a reply drafted for each new one, but I approve every reply before it counts." },
      { role: "assistant", content: "Where should approved replies go?" },
      { role: "user", content: "Into a Replies tab, marked ready to send, or skipped if I say no. Check every 15 minutes, one enquiry at a time. Keep it to a few steps." },
    ],
    sheets: {
      Enquiries: [
        { name: "Jordan Lee", contact: "jordan@example.com", interest: "spring workshop", message: "Are there places left for the March workshop?" },
        { name: "Alex Moreno", contact: "alex@example.com", interest: "gift vouchers", message: "Do you sell gift vouchers, and for how much?" },
        { name: "Sam Patel", contact: "sam@example.com", interest: "group booking", message: "Could six of us book an evening class?" },
      ],
      Replies: [{ name: "Jordan Lee", contact: "jordan@example.com", reply: "Hi Jordan, thanks for asking about the spring workshop. There are four places left.", status: "ready to send" }],
    },
    memory: {},
    answers: ["Yes"],
    setting: (key, type) => {
      if (type === "sheet" || /sheet|tab/i.test(key)) return /repl/i.test(key) ? "Replies" : "Enquiries";
      if (/business|shop|name/i.test(key)) return "Northside Craft Studio";
      if (/template/i.test(key)) return "Hi {name}, thanks for asking about {interest}. Here is what we can offer: ";
      return type === "number" ? 0 : "";
    },
  },
};

interface LiveCall {
  to: "serv" | "dolphin";
  what: string;
  status: number;
  ms: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
}
const calls: LiveCall[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const to = url.includes("lighthouse.dphn.ai") ? "dolphin" : url.includes("inference-api.openserv.ai") ? "serv" : null;
  if (!to) throw new Error(`seed: refused a call to ${new URL(url).host}`);
  if (calls.filter((c) => c.to === to).length >= BUDGET[to]) throw new Error(`seed: the ${to} budget of ${BUDGET[to]} calls is used up`);
  const body = JSON.parse(String(init?.body ?? "{}")) as { response_format?: { json_schema?: { name?: string } } };
  const what = to === "dolphin" ? "code" : (body.response_format?.json_schema?.name ?? "text");
  const started = Date.now();
  let res: Response;
  try {
    res = await realFetch(input, init);
  } catch (err) {
    calls.push({ to, what, status: 0, ms: Date.now() - started, promptTokens: null, completionTokens: null, reasoningTokens: null });
    throw err;
  }
  const parsed = (await res.clone().json().catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } } | null;
  calls.push({
    to,
    what,
    status: res.status,
    ms: Date.now() - started,
    promptTokens: parsed?.usage?.prompt_tokens ?? null,
    completionTokens: parsed?.usage?.completion_tokens ?? null,
    reasoningTokens: parsed?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
  });
  return res;
}) as typeof fetch;

function report() {
  console.log("\nLive calls:");
  for (const c of calls) {
    console.log(`  ${c.to.padEnd(7)} ${c.what.padEnd(12)} ${(c.status ? String(c.status) : "cut").padEnd(4)} ${String(c.ms).padStart(6)} ms  in ${c.promptTokens ?? "?"}  out ${c.completionTokens ?? "?"}${c.reasoningTokens ? ` (reasoning ${c.reasoningTokens})` : ""}`);
  }
  console.log(`  SERV ${calls.filter((c) => c.to === "serv").length} of ${BUDGET.serv}, Dolphin ${calls.filter((c) => c.to === "dolphin").length} of ${BUDGET.dolphin}`);
  if (process.env.SEED_CALLS_OUT) writeFileSync(process.env.SEED_CALLS_OUT, JSON.stringify(calls, null, 2));
}

async function main() {
  const name = process.env.SEED_EXAMPLE ?? "";
  const ex = EXAMPLES[name];
  if (!ex) throw new Error(`seed: SEED_EXAMPLE must be one of ${Object.keys(EXAMPLES).join(", ")}`);
  const out = fileURLToPath(new URL(`../src/lib/agents/examples/${name}.json`, import.meta.url));
  const serv = servOnly(modelConfig(process.env));
  const dolphin = dolphinProvider();
  if (!serv.providers.length || !dolphin) throw new Error("seed: SERV_API_KEY and DOLPHIN_API_KEY must be set");
  const signal = new AbortController().signal;

  const saved =
    process.env.SEED_RESUME === "1" && existsSync(out)
      ? (JSON.parse(readFileSync(out, "utf8")) as { definition: AgentDefinition; code: Record<string, Omit<StepCode, "spec" | "updatedAt">>; bench: BenchData; planTries: number })
      : null;
  let d: AgentDefinition;
  let planTries = 0;
  const kept = saved ? checkDefinition(saved.definition) : null;
  // SERV's answers from an earlier run (SEED_PLAN_FROM, as SEED_PLAN_OUT
  // kept them) are read again with no call, so none is wasted.
  const earlier = process.env.SEED_PLAN_FROM ? (JSON.parse(readFileSync(process.env.SEED_PLAN_FROM, "utf8")) as string[]) : [];
  const reread = earlier.map((a) => checkDefinition(wireToDefinition(JSON.parse(a) as Record<string, unknown>))).find((c) => c.ok);
  if (kept?.ok && process.env.SEED_FIX) {
    console.log(`Changing the saved plan with SERV: "${process.env.SEED_FIX}"`);
    const plan = await planAgent({ interview: ex.interview, history: ex.history, current: kept.definition, feedback: process.env.SEED_FIX }, { config: serv, signal });
    if (process.env.SEED_PLAN_OUT) writeFileSync(process.env.SEED_PLAN_OUT, JSON.stringify(plan.answers, null, 2));
    if (!plan.definition) throw new Error(`seed: no changed plan: ${plan.errors.join(" ")}`);
    d = plan.definition;
    planTries = saved!.planTries + plan.calls.length;
  } else if (kept?.ok) {
    console.log("Resuming the saved example: its plan stays, no plan call.");
    d = kept.definition;
    planTries = saved!.planTries;
  } else if (reread?.ok) {
    console.log(`Read SERV's earlier plan again (${process.env.SEED_PLAN_FROM}), no call.`);
    d = reread.definition;
    planTries = earlier.length;
  } else {
    console.log(`Planning "${ex.interview.name}" with SERV...`);
    const plan = await planAgent({ interview: ex.interview, history: ex.history }, { config: serv, signal });
    if (process.env.SEED_PLAN_OUT) writeFileSync(process.env.SEED_PLAN_OUT, JSON.stringify(plan.answers, null, 2));
    if (!plan.definition) throw new Error(`seed: no plan: ${plan.errors.join(" ")}`);
    d = plan.definition;
    planTries = plan.calls.length;
  }
  const codeSteps = d.steps.filter((s): s is CodeStepDef => s.kind === "code");
  console.log(`Planned${planTries ? ` in ${planTries} ${planTries === 1 ? "try" : "tries"}` : ""}: ${d.steps.map((s) => `${s.id} (${s.kind})`).join(", ")}`);
  const before = new Map(saved?.definition.steps.flatMap((s) => (s.kind === "code" ? [[s.id, codeSpec(s)] as const] : [])) ?? []);
  const toWrite = codeSteps.filter((s) => saved?.code[s.id]?.status !== "approved" || before.get(s.id) !== codeSpec(s)).length;
  if (toWrite > MAX_CODE_STEPS) throw new Error(`seed: ${toWrite} code steps to write is more than the Dolphin budget allows for`);

  const code: Record<string, StepCode> = {};
  for (const step of codeSteps) {
    const was = saved?.code[step.id];
    if (was?.status === "approved" && before.get(step.id) === codeSpec(step)) {
      code[step.id] = { ...was, spec: codeSpec(step), updatedAt: new Date().toISOString() };
      console.log(`Keeping "${step.title}": approved after ${was.rounds} ${was.rounds === 1 ? "round" : "rounds"}.`);
      continue;
    }
    console.log(`Writing "${step.title}" with Dolphin, reviewed by SERV...`);
    code[step.id] = await writeStep(step, d, codeSpec(step), { dolphin, serv, signal, hooks: { progress: async () => {}, record: async () => {} } });
    console.log(`  ${code[step.id]!.status} after ${code[step.id]!.rounds} ${code[step.id]!.rounds === 1 ? "round" : "rounds"}${code[step.id]!.note ? `: ${code[step.id]!.note}` : ""}`);
  }

  const settings: Record<string, unknown> = {};
  for (const s of d.settings) {
    const rule = d.rules.find((r) => r.key === s.key);
    settings[s.key] = rule ? (s.type === "number" ? Number(rule.value) : rule.value) : ex.setting(s.key, s.type);
  }
  const bench: BenchData = {
    settings,
    rules: {},
    trigger: null,
    sheets: ex.sheets,
    pages: {},
    search: {},
    telegram: { answers: ex.answers },
    memory: ex.memory,
    wallet: { balanceUsdc: 0 },
    decisions: {},
  };
  const decisions = d.steps.filter((s) => s.kind === "decision");
  const fits = (id: string, outcome: string) => decisions.some((s) => s.kind === "decision" && s.id === id && s.outcomes.some((o) => o.id === outcome));
  const recorded = Object.fromEntries(Object.entries(saved?.bench.decisions ?? {}).filter(([id, o]) => fits(id, o)));
  if (!decisions.length) {
    console.log("No decisions to record.");
  } else if (decisions.every((s) => s.id in recorded)) {
    bench.decisions = recorded;
    console.log(`Keeping the decisions recorded earlier: ${JSON.stringify(bench.decisions)}`);
  } else {
    console.log("One live run on the bench, SERV deciding...");
    const live: RunEvent[] = [];
    const end = await runAgent({ definition: d, code, bench, dryRun: false, serv, signal, onEvent: (e) => live.push(e) });
    for (const e of live) if (e.type === "step_done" && e.outcome) bench.decisions[e.stepId] = e.outcome;
    console.log(`  ${end.status}: ${end.reason} ${end.steps} steps, $${end.costUsd.toFixed(5)}`);
  }
  const dry: RunEvent[] = [];
  const dryEnd = await runAgent({ definition: d, code, bench, dryRun: true, onEvent: (e) => dry.push(e) });
  console.log(`  dry run: ${dryEnd.status}: ${dryEnd.reason}`);
  for (const e of dry) if (e.type === "tool" && (e.tool === "telegram.send" || e.tool === "telegram.ask" || e.tool === "sheets.write")) console.log(`  ${e.tool}: ${JSON.stringify(e.args).slice(0, 300)}`);

  writeFileSync(
    out,
    `${JSON.stringify(
      {
        note: "Built by scripts/seed-examples.ts: planned by SERV, code written by Dolphin and reviewed by SERV.",
        builtAt: new Date().toISOString(),
        interview: ex.interview,
        definition: d,
        code: Object.fromEntries(Object.entries(code).map(([k, c]) => [k, { status: c.status, source: c.source, rounds: c.rounds, note: c.note, writer: c.writer }])),
        bench,
        planTries,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Saved ${out}`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "seed failed");
    process.exitCode = 1;
  })
  .finally(report);
