// The weekly payment agent (suite request 8) run for real, once: its plan
// and code as the live suite built them (AGENT_FILE, a SUITE_REPORT), on an
// in-memory database, through the real runtime: the job, the payment's own
// approval, the SERV guard, the allowance, and the treasury's USDC transfer
// on Base Sepolia to the payee saved as Designer, the wallet named in
// LIVE_PAYEE_ADDRESS (required: nothing is paid to an address in the code).
// The approval is answered "Yes" here, as the in-app approval is
// (Telegram's buttons answer the same approval; this run has no chat).
//
// By default nothing is sent: the transfer is signed and stops there. With
// SEND=1 it is sent, confirmed, spent from the allowance and receipted.
// Before you send: the site's own reconciliation (spending/reconcile.ts)
// reads every transfer from the treasury, and one this database made isn't
// in the site's, so it raises an alert and pauses agent payments until an
// admin resumes them (Admin, Agent payments). Prints statuses, timings, the
// SERV calls and the transaction, never a key.
//
//   AGENT_FILE=report.json LIVE_PAYEE_ADDRESS=0x... [SEND=1] npx vite-node --config vitest.config.ts scripts/live-designer-payment.ts

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { getAddress, isAddress, type Hex } from "viem";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { linkConnections, publishedAgent, testRuntime } from "@/test/runtimeFixtures";
import { servOnly } from "@/lib/agents/build";
import { givenAnswers, type AgentDefinition } from "@/lib/agents/definition";
import type { StepCode } from "@/lib/agents/types";
import { install } from "@/lib/agents/runtime/installations";
import { jobWorker } from "@/lib/agents/runtime/worker";
import { enqueue } from "@/lib/agents/runtime/jobs";
import { answer, approvalsOf } from "@/lib/agents/runtime/approvals";
import { modelConfig } from "@/lib/model";
import { readPaymentsConfig } from "@/lib/payments/config";
import { viemChainClient } from "@/lib/payments/chain";
import { treasurySigner } from "@/lib/payments/signer";
import { post } from "@/lib/payments/ledger";
import { topUp } from "@/lib/spending/allowance";
import { savePayee } from "@/lib/spending/payees";
import { receiptsOf } from "@/lib/spending/receipts";

const SEPOLIA_USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const SEND = process.env.SEND === "1";
const BUDGET = Number(process.env.LIVE_SERV_BUDGET ?? 4);
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const servCalls: { status: number; ms: number; promptTokens: number | null; completionTokens: number | null }[] = [];

async function main() {
  const file = process.env.AGENT_FILE;
  if (!file) throw new Error("AGENT_FILE: the live suite's report");
  const report = JSON.parse(readFileSync(file, "utf8")) as { agents: Record<string, { definition: AgentDefinition; code: Record<string, StepCode> } | null> };
  const built = report.agents.designer;
  if (!built?.definition) throw new Error("The report has no weekly payment agent.");
  const config = readPaymentsConfig(process.env);
  if (config.chainId !== 84532 || config.network !== "base-sepolia" || getAddress(config.currencies.USDC.token!) !== SEPOLIA_USDC) throw new Error("Base Sepolia only: refusing.");
  if (process.env.AGENT_PAYMENTS_MAINNET) throw new Error("AGENT_PAYMENTS_MAINNET is set: refusing.");
  const payee = process.env.LIVE_PAYEE_ADDRESS?.trim();
  if (!payee || !isAddress(payee)) throw new Error("LIVE_PAYEE_ADDRESS: the wallet to pay, a 0x address");
  const wallet = getAddress(payee);
  const signer = treasurySigner(config);
  if ("problem" in signer) throw new Error(signer.problem);
  const real = viemChainClient(config);
  // Unless SEND=1, the signed transfer is kept here and never sent.
  let signed: Hex | null = null;
  const chain = SEND ? real : { ...real, sendRaw: async (raw: Hex) => void (signed = raw) };

  const { db } = await testDb();
  const rt = testRuntime(db, new Date());
  rt.now = () => new Date();
  const serv = servOnly(modelConfig(process.env));
  if (!serv.providers.length) throw new Error("SERV_API_KEY must be set");
  rt.serv = () => ({ config: serv, ownKey: false });
  rt.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("inference-api.openserv.ai")) throw new Error("live: refused a call that isn't SERV");
    if (servCalls.length >= BUDGET) throw new Error(`live: the SERV budget of ${BUDGET} calls is used up`);
    const started = Date.now();
    const res = await fetch(input, init);
    const body = (await res.clone().json().catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
    servCalls.push({ status: res.status, ms: Date.now() - started, promptTokens: body?.usage?.prompt_tokens ?? null, completionTokens: body?.usage?.completion_tokens ?? null });
    return res;
  }) as typeof fetch;
  rt.payments = { config, chain, signer: () => signer, wait: (ms) => new Promise((r) => setTimeout(r, ms)), confirmWithinMs: SEND ? 180_000 : 3_000 };
  process.env.OPENSERV_KEY_ENC_KEY ||= randomBytes(32).toString("base64");

  // The maker runs their own agent: Run it for me, with what they gave.
  const maker = await addUser(db, "live.designer", "live_designer");
  await linkConnections(rt, maker);
  const p = await publishedAgent(db, maker, { definition: built.definition, code: built.code });
  const given = givenAnswers(built.definition);
  const settings = Object.fromEntries(built.definition.settings.map((s) => [s.key, given[s.key] ?? (/payee|who/i.test(`${s.key} ${s.label}`) ? "Designer" : /amount|usdc|much/i.test(`${s.key} ${s.label}`) ? "0.5" : "")]));
  const inst = await install(rt, { ownerUserId: maker.id, agent: p.agent, version: p.version, answers: { settings, rules: {}, timezone: "Europe/London", minGapMinutes: 0 } });
  console.log(`${at()} installed, asks before every payment (auto limit 0); settings ${JSON.stringify(settings)}`);
  // Its allowance: 1 test USDC, from the maker's balance.
  await post(db as never, { userId: maker.id, currency: "USDC", kind: "deposit", amount: 1_000_000n, key: `live:designer:${randomBytes(4).toString("hex")}` });
  await topUp(rt, maker, inst.id, 1_000_000n, `live-designer-${randomBytes(4).toString("hex")}`);
  await savePayee(rt, maker, inst.id, { label: "Designer", address: wallet });
  console.log(`${at()} allowance 1 USDC; payee Designer saved at ${wallet}`);

  const worker = jobWorker(rt);
  const settle = async () => {
    await worker.cycle();
    await Promise.all(worker.running());
  };
  const job = await enqueue(rt, inst, { kind: "manual" });
  await settle();
  const [ask] = await approvalsOf(rt, maker.id, { pendingOnly: true });
  if (!ask) throw new Error("It didn't ask before paying.");
  console.log(`${at()} asked: ${ask.question.split("\n")[0]}`);
  console.log(`           why: ${ask.reason ?? ""}`);
  await answer(rt, maker.id, ask.id, "Yes");
  console.log(`${at()} answered Yes`);
  await settle();
  const [pay] = await db.select().from(schema.agentPayments).where(eq(schema.agentPayments.installationId, inst.id));
  console.log(`${at()} payment: ${pay?.status} ${pay?.amount} (USDC minor units) to ${pay?.payeeLabel} ${pay?.toAddress}, nonce ${pay?.nonce}, guard ${pay?.guard}: ${pay?.guardReason ?? ""}`);
  if (!SEND) {
    console.log(`${at()} signed, not sent (SEND=1 sends it): ${pay?.txHash} (${signed ? `${(signed as string).length} hex chars` : "no bytes"})`);
  } else {
    for (let i = 0; i < 60 && (await db.select().from(schema.agentPayments).where(eq(schema.agentPayments.id, pay!.id)))[0]?.status !== "confirmed"; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      await settle();
    }
    const [r] = await receiptsOf(rt, { installationId: inst.id });
    console.log(`${at()} receipt: ${JSON.stringify(r)}`);
  }
  const [j] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
  console.log(`${at()} job: ${j?.status}: ${j?.reason ?? ""}`);
  for (const s of await db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, job.id)).orderBy(asc(schema.agentJobSteps.seq))) {
    console.log(`  ${s.stepId.padEnd(22)} ${s.status.padEnd(8)} ${s.note ? s.note.slice(0, 120) : ""}`);
  }
  worker.stop();
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "live run failed");
    process.exitCode = 1;
  })
  .finally(() => {
    console.log("SERV calls:");
    for (const c of servCalls) console.log(`  ${c.status} ${String(c.ms).padStart(6)} ms  in ${c.promptTokens ?? "?"}  out ${c.completionTokens ?? "?"}`);
    console.log(`  ${servCalls.length} of ${BUDGET}`);
  });
