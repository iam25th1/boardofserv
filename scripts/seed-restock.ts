// Builds the example agent, a fabric shop's restock agent, through the real
// pipeline, and saves it for the demo and the tests:
//
//   1. SERV plans it from a fixed interview (planAgent, checked, up to three
//      tries): stock from a sheet, supplier prices from the suppliers' price
//      page (examples/supplierPage.ts) with web.fetch,
//   2. Dolphin writes each code step and SERV reviews it (writeStep),
//   3. one live run on the test bench lets SERV make each decision, and the
//      answers are recorded, so the demo's dry runs replay them with no model
//      call.
//
// It writes src/lib/agents/examples/restock.json and touches no database.
// It needs SERV_API_KEY and DOLPHIN_API_KEY in its environment, and stops
// before making more model calls than BUDGET allows. Every call is listed at
// the end with its status, tokens and time, never a key.
//
//   npx vite-node --config vitest.config.ts scripts/seed-restock.ts
//
// SEED_RESUME=1 picks up the saved example instead: its plan, its approved
// code and its recorded decisions stay, only code steps without approved
// code are written and reviewed, and the run is a dry one, with no plan call
// and no decision call. With SEED_FIX="what went wrong" as well, SERV first
// changes the saved plan from those words, as fixing by chatting does in the
// builder, and only the code steps whose job changed are written again.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { servOnly } from "@/lib/agents/build";
import { dolphinProvider, writeStep } from "@/lib/agents/code";
import { checkDefinition, codeSpec, type AgentDefinition, type CodeStepDef } from "@/lib/agents/definition";
import { planAgent, wireToDefinition } from "@/lib/agents/plan";
import { runAgent } from "@/lib/agents/runner";
import { pageText } from "@/lib/agents/runtime/webFetch";
import { SUPPLIERS_HTML, SUPPLIERS_URL } from "@/lib/agents/examples/supplierPage";
import type { BenchData, RunEvent, StepCode } from "@/lib/agents/types";
import { modelConfig, type ChatMessage } from "@/lib/model";
import type { SketchDTO } from "@/lib/types";

const OUT = fileURLToPath(new URL("../src/lib/agents/examples/restock.json", import.meta.url));
const BUDGET = { serv: Number(process.env.SEED_SERV_BUDGET ?? 10), dolphin: Number(process.env.SEED_DOLPHIN_BUDGET ?? 6) };
// More code steps than Dolphin calls left would stop part way.
const MAX_CODE_STEPS = Math.min(4, BUDGET.dolphin);

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
  const started = Date.now();
  let res: Response;
  try {
    res = await realFetch(input, init);
  } catch (err) {
    // Sent and then cut off (a timeout) or never answered: it still counts.
    calls.push({ to, what: to === "dolphin" ? "code" : (body.response_format?.json_schema?.name ?? "text"), status: 0, ms: Date.now() - started, promptTokens: null, completionTokens: null, reasoningTokens: null });
    throw err;
  }
  const parsed = (await res.clone().json().catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } } | null;
  calls.push({
    to,
    what: to === "dolphin" ? "code" : (body.response_format?.json_schema?.name ?? "text"),
    status: res.status,
    ms: Date.now() - started,
    promptTokens: parsed?.usage?.prompt_tokens ?? null,
    completionTokens: parsed?.usage?.completion_tokens ?? null,
    reasoningTokens: parsed?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
  });
  return res;
}) as typeof fetch;

// The maker's interview, as the builder chat would have it.
const INTERVIEW: SketchDTO = {
  name: "Fabric restock",
  kind: "agent",
  watches: null,
  when: null,
  how: null,
  tells: null,
  takes: null,
  does: null,
  gives: null,
  wakes: "every morning at 08:00",
  looks:
    "the Stock sheet (columns fabric, metres, minimum) and the suppliers' price list web page, whose address the owner gives: after a header line, each line is 'supplier | fabric | price_usdc | delivery_days', price_usdc per metre",
  handles: "for each fabric below its minimum, pick the cheapest supplier that delivers within the longest delivery the owner allows, and order enough metres to reach twice the minimum",
  finish: "every low fabric has an order row in the Orders sheet, or the owner said no",
  asks: "never place an order whose total is over the approval limit in USDC without asking the owner on Telegram first",
  setup: "the names of the stock and orders sheets, the address of the suppliers' price page, the approval limit (250 USDC) and the longest delivery (7 days)",
  remembers: "the last order it placed, as a record { placed_at, lines }",
  asking: null,
  live: false,
};

const HISTORY: ChatMessage[] = [
  { role: "user", content: "I run a small fabric shop. Every morning I want my stock checked and anything low reordered from the best of my three suppliers." },
  { role: "assistant", content: "What must it never do without asking you first?" },
  { role: "user", content: "Never place an order over 250 USDC without asking me on Telegram. Keep it to a few steps." },
];

const STOCK = [
  { fabric: "Linen, natural", metres: 4, minimum: 20 },
  { fabric: "Cotton twill", metres: 55, minimum: 30 },
  { fabric: "Wool felt", metres: 6, minimum: 10 },
  { fabric: "Canvas, heavy", metres: 12, minimum: 15 },
];

function report() {
  console.log("\nLive calls:");
  for (const c of calls) {
    console.log(`  ${c.to.padEnd(7)} ${c.what.padEnd(12)} ${(c.status ? String(c.status) : "cut").padEnd(4)} ${String(c.ms).padStart(6)} ms  in ${c.promptTokens ?? "?"}  out ${c.completionTokens ?? "?"}${c.reasoningTokens ? ` (reasoning ${c.reasoningTokens})` : ""}`);
  }
  console.log(`  SERV ${calls.filter((c) => c.to === "serv").length} of ${BUDGET.serv}, Dolphin ${calls.filter((c) => c.to === "dolphin").length} of ${BUDGET.dolphin}`);
  if (process.env.SEED_CALLS_OUT) writeFileSync(process.env.SEED_CALLS_OUT, JSON.stringify(calls, null, 2));
}

async function main() {
  const config = modelConfig(process.env);
  const serv = servOnly(config);
  const dolphin = dolphinProvider();
  if (!serv.providers.length || !dolphin) throw new Error("seed: SERV_API_KEY and DOLPHIN_API_KEY must be set");
  const signal = new AbortController().signal;

  // SERV's answers from an earlier run can be read again (SEED_PLAN_FROM),
  // with no call, and every new answer is kept (SEED_PLAN_OUT), so none is
  // ever wasted.
  let d: AgentDefinition;
  let planTries = 0;
  const resume = process.env.SEED_RESUME === "1";
  const earlier = process.env.SEED_PLAN_FROM ? (JSON.parse(readFileSync(process.env.SEED_PLAN_FROM, "utf8")) as string[]) : [];
  const reread = earlier.map((a) => checkDefinition(wireToDefinition(JSON.parse(a) as Record<string, unknown>))).find((c) => c.ok);
  const prior = resume ? (JSON.parse(readFileSync(OUT, "utf8")) as { definition: unknown; planTries: number }) : null;
  const priorPlan = prior ? checkDefinition(prior.definition) : null;
  const priorShape = prior ? (prior.definition as AgentDefinition) : null;
  if (resume && process.env.SEED_FIX && priorShape) {
    console.log(`Changing the saved plan with SERV: "${process.env.SEED_FIX}"`);
    const plan = await planAgent({ interview: INTERVIEW, history: HISTORY, current: priorShape, feedback: process.env.SEED_FIX }, { config: serv, signal });
    if (process.env.SEED_PLAN_OUT) writeFileSync(process.env.SEED_PLAN_OUT, JSON.stringify(plan.answers, null, 2));
    if (!plan.definition) throw new Error(`seed: no changed plan: ${plan.errors.join(" ")}`);
    d = plan.definition;
    planTries = prior!.planTries + plan.calls.length;
  } else if (priorPlan?.ok) {
    console.log("Resuming the saved example: its plan stays, no plan call.");
    d = priorPlan.definition;
    planTries = prior!.planTries;
  } else if (reread?.ok) {
    console.log(`Read SERV's earlier plan again (${process.env.SEED_PLAN_FROM}), no call.`);
    d = reread.definition;
  } else {
    console.log("Planning with SERV...");
    const plan = await planAgent({ interview: INTERVIEW, history: HISTORY }, { config: serv, signal });
    if (process.env.SEED_PLAN_OUT) writeFileSync(process.env.SEED_PLAN_OUT, JSON.stringify([...earlier, ...plan.answers], null, 2));
    if (!plan.definition) throw new Error(`seed: no plan: ${plan.errors.join(" ")}`);
    d = plan.definition;
    planTries = plan.calls.length;
  }
  const codeSteps = d.steps.filter((s): s is CodeStepDef => s.kind === "code");
  console.log(`Planned${planTries ? ` in ${planTries} ${planTries === 1 ? "try" : "tries"}` : ""}: ${d.steps.map((s) => `${s.id} (${s.kind})`).join(", ")}`);
  const keptFile = resume ? (JSON.parse(readFileSync(OUT, "utf8")) as { definition: AgentDefinition; code: Record<string, { status: string }> }) : null;
  const keptSpec = new Map(keptFile?.definition.steps.flatMap((s) => (s.kind === "code" ? [[s.id, codeSpec(s)] as const] : [])) ?? []);
  const toWrite = codeSteps.filter((s) => keptFile?.code[s.id]?.status !== "approved" || keptSpec.get(s.id) !== codeSpec(s)).length;
  if (toWrite > MAX_CODE_STEPS) throw new Error(`seed: ${toWrite} code steps to write is more than the Dolphin budget allows for`);

  const code: Record<string, StepCode> = {};
  const saved = resume ? (JSON.parse(readFileSync(OUT, "utf8")) as { definition: AgentDefinition; code: Record<string, Omit<StepCode, "spec" | "updatedAt">>; bench: BenchData }) : null;
  const before = new Map(saved?.definition.steps.flatMap((s) => (s.kind === "code" ? [[s.id, codeSpec(s)] as const] : [])) ?? []);
  for (const step of codeSteps) {
    const kept = saved?.code[step.id];
    // Kept only while the step asks for exactly what it asked before.
    if (kept?.status === "approved" && before.get(step.id) === codeSpec(step)) {
      code[step.id] = { ...kept, spec: codeSpec(step), updatedAt: new Date().toISOString() };
      console.log(`Keeping "${step.title}": approved after ${kept.rounds} ${kept.rounds === 1 ? "round" : "rounds"}.`);
      continue;
    }
    console.log(`Writing "${step.title}" with Dolphin, reviewed by SERV...`);
    code[step.id] = await writeStep(step, d, codeSpec(step), {
      dolphin,
      serv,
      signal,
      hooks: { progress: async () => {}, record: async () => {} },
    });
    console.log(`  ${code[step.id]!.status} after ${code[step.id]!.rounds} ${code[step.id]!.rounds === 1 ? "round" : "rounds"}${code[step.id]!.note ? `: ${code[step.id]!.note}` : ""}`);
  }

  // The bench: the shop's sheets, and each setting answered from its name.
  const settings: Record<string, unknown> = {};
  for (const s of d.settings) {
    const k = s.key.toLowerCase();
    const rule = d.rules.find((r) => r.key === s.key);
    if (rule) settings[s.key] = s.type === "number" ? Number(rule.value) : rule.value;
    else if (s.type === "number") settings[s.key] = 0;
    else if (s.type === "boolean") settings[s.key] = false;
    else if (s.type === "url") settings[s.key] = SUPPLIERS_URL;
    else settings[s.key] = /order/.test(k) ? "Orders" : /stock/.test(k) ? "Stock" : "";
  }
  const bench: BenchData = {
    settings,
    rules: {},
    trigger: null,
    sheets: { Stock: STOCK, Orders: [] },
    // The price page's text, as web.fetch gives it.
    pages: { [SUPPLIERS_URL]: pageText(SUPPLIERS_HTML) },
    search: {},
    telegram: { answers: ["Yes, go ahead"] },
    memory: {},
    wallet: { balanceUsdc: 1000 },
    decisions: {},
  };

  const fits = (id: string, outcome: string) => d.steps.some((s) => s.kind === "decision" && s.id === id && s.outcomes.some((o) => o.id === outcome));
  const recorded = Object.fromEntries(Object.entries(saved?.bench.decisions ?? {}).filter(([id, o]) => fits(id, o)));
  const decisions = d.steps.filter((s) => s.kind === "decision");
  if (saved && decisions.every((s) => s.id in recorded)) {
    bench.decisions = recorded;
    console.log(`Keeping the decisions recorded from the earlier live run: ${JSON.stringify(bench.decisions)}`);
  } else {
    console.log("One live run on the bench, SERV deciding...");
    const live: RunEvent[] = [];
    const liveEnd = await runAgent({ definition: d, code, bench, dryRun: false, serv, signal, onEvent: (e) => live.push(e) });
    for (const e of live) if (e.type === "step_done" && e.outcome) bench.decisions[e.stepId] = e.outcome;
    console.log(`  ${liveEnd.status}: ${liveEnd.reason} ${liveEnd.steps} steps, $${liveEnd.costUsd.toFixed(5)}`);
  }

  // The same run, dry, from the recorded answers: what the demo replays.
  const dry: RunEvent[] = [];
  const dryEnd = await runAgent({ definition: d, code, bench, dryRun: true, onEvent: (e) => dry.push(e) });
  console.log(`  dry run: ${dryEnd.status}: ${dryEnd.reason}`);

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        note: "Built by scripts/seed-restock.ts: planned by SERV, code written by Dolphin and reviewed by SERV, decisions recorded from one live run.",
        builtAt: new Date().toISOString(),
        interview: INTERVIEW,
        definition: d,
        code: Object.fromEntries(Object.entries(code).map(([k, c]) => [k, { status: c.status, source: c.source, rounds: c.rounds, note: c.note }])),
        bench,
        planTries,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Saved ${OUT}`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "seed failed");
    process.exitCode = 1;
  })
  .finally(report);
