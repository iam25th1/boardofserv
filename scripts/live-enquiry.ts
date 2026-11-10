// Runs the example Enquiry follow-up live on its own test bench, twice:
// SERV makes its two decisions for real (is there a new enquiry, and what
// did the owner answer), the tools answer from the bench (its sheets, and
// the owner's answer to its question: "Yes" the first time, "No" the
// second). No database, no Google, no Telegram. It prints each run's
// decisions and the row it wrote to the replies tab, and every SERV try with
// its answer limit, status, tokens, time and whether the answer was empty,
// never a key. It stops before more than LIVE_SERV_BUDGET SERV calls (4).
//
//   SERV_API_KEY=... npx vite-node --config vitest.config.ts scripts/live-enquiry.ts

import { servOnly } from "@/lib/agents/build";
import { checkDefinition } from "@/lib/agents/definition";
import lead from "@/lib/agents/examples/lead-followup.json";
import { runAgent } from "@/lib/agents/runner";
import type { BenchData, RunEvent, StepCode } from "@/lib/agents/types";
import { jsonAnswer, modelConfig } from "@/lib/model";

const BUDGET = Number(process.env.LIVE_SERV_BUDGET ?? 4);
const serv = servOnly(modelConfig(process.env));
if (!serv.providers.length) {
  console.error("live-enquiry: set SERV_API_KEY.");
  process.exit(2);
}
const checked = checkDefinition(lead.definition);
if (!checked.ok) throw new Error(checked.errors.join(" "));

type Try = { run: string; limit: number; status: number; ms: number; tokens: string; empty: boolean };
const tries: Try[] = [];
let run = "";
const counted = (async (url: string, init: RequestInit) => {
  if (tries.length >= BUDGET) throw new Error(`live-enquiry: the budget of ${BUDGET} SERV calls is used up.`);
  const t = Date.now();
  const sent = JSON.parse(String(init.body)) as { max_tokens: number };
  const res = await fetch(url, init);
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { message?: { content?: string | null } }[] };
  tries.push({ run, limit: sent.max_tokens, status: res.status, ms: Date.now() - t, tokens: `${body.usage?.prompt_tokens ?? "?"}+${body.usage?.completion_tokens ?? "?"}`, empty: res.ok && jsonAnswer(body.choices?.[0]?.message?.content) !== "ok" });
  return res;
}) as typeof fetch;

let ok = true;
for (const [answer, expected] of [
  ["Yes", "ready to send"],
  ["No", "skipped"],
] as const) {
  run = `owner says ${answer}`;
  const bench = structuredClone(lead.bench) as unknown as BenchData;
  bench.telegram = { ...bench.telegram, answers: [answer] };
  const decided: string[] = [];
  const end = await runAgent({
    definition: checked.definition,
    code: lead.code as unknown as Record<string, StepCode>,
    bench,
    dryRun: false,
    serv,
    fetchImpl: counted,
    onEvent: (e: RunEvent) => {
      if (e.type === "step_done" && e.outcome) decided.push(`${e.stepId}: ${e.outcome}`);
    },
  });
  const row = end.sheets[String(bench.settings.replies_sheet)]?.at(-1) as { name?: string; status?: string } | undefined;
  const right = end.status === "done" && row?.status === expected;
  ok &&= right;
  console.log(`${run}: ${end.status} in ${end.steps} steps (${end.reason}) ${decided.join(", ")}; wrote ${row?.name ?? "nothing"} as "${row?.status ?? ""}" ${right ? "as it should" : `, expected "${expected}"`}`);
}
for (const x of tries) console.log(`  SERV ${x.run}: ${x.status}, ${x.tokens} tokens (limit ${x.limit}), ${x.ms} ms${x.empty ? ", empty" : ""}`);
process.exit(ok ? 0 : 1);
