import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { meterPlatform, platformRoom } from "./metering";
import { messages, replyUsage, type Agent, type AgentVersion } from "../db/schema";
import { loadSketch } from "../sketchStore";
import { describeFailures, modelPrices, type JsonResult, type ModelConfig } from "../model";
import type { AgentSummaryDTO } from "../types";
import { dolphinProvider, writeStep } from "./code";
import { codeSpec, givenAnswers, nextOf, setupShapeOf, type AgentDefinition, type CodeStepDef } from "./definition";
import { stepDepths, stepLine, stepsInOrder } from "./plainView";
import { planAgent, planCallCap, type PlanInput } from "./plan";
import { setHeal, setStepCode, updateDraft, versionById } from "./store";
import { planFailure, problemOf } from "./plainWords";
import { selfTest } from "./test";
import { emptyHeal, type Diagnosis, type HealLog, type HealRound, type StepCode, type TestResult } from "./types";
import { errorText } from "../db/errors";
import { recordAttempts } from "../modelAttempts";
import { codeDiagnosis, planDiagnosis, testDiagnosis, withDiagnosis } from "./diagnosis";
import { askFixer, type FixVerdict } from "./fixer";
import { foundLine, freshBuild, gaveUpLine, healLimits, repairLine, roundsUsed, withLine, withRound } from "./heal";
import { weakens } from "./guarded";
import { learn, recurringRules } from "./lessons";

// The build: planning, then the code, then its self test, runs in the
// background, because it can take longer than a request may. One job per
// draft at a time, kept in this process; the draft's build_state says
// where it is, and the builder polls it. A server restart mid-build leaves
// a state no job owns, which the next look calls failed (settle).
//
// A build heals itself: every failure (a plan that doesn't check out, a
// step's code that doesn't pass its check, a self test that fails) is a
// diagnosis (diagnosis.ts) the fixer reads (fixer.ts), and its repair is
// made and the build goes on from there, round after round, until it
// passes, or its rounds or its model budget run out (heal.ts). The maker
// sees calm plain lines while it does, a plain question when only they can
// say, and one sentence with two choices if it gives up.

const jobs = new Map<string, Promise<void>>();
// Each job's stop: aborting it ends its model calls where they are, and
// the job goes no further (stopBuild).
const aborts = new Map<string, AbortController>();

// A job on a draft, kept so it can be waited on and stopped.
function track(versionId: string, abort: AbortController, job: Promise<void>): void {
  const kept = job.finally(() => {
    jobs.delete(versionId);
    if (aborts.get(versionId) === abort) aborts.delete(versionId);
  });
  jobs.set(versionId, kept);
}

function begin(versionId: string): AbortController {
  const abort = new AbortController();
  aborts.set(versionId, abort);
  return abort;
}

export const STOPPED_NOTE = "Stopped. What was done is kept: change what you like and send it again.";

// The maker's Stop while the chat plans, builds, tests or heals: the job's
// model calls are aborted where they are, nothing more is started, and
// the draft rests with what was done (steps, approved code), its other
// steps' code back in the queue. False when nothing was running.
export async function stopBuild(versionId: string, waitMs = 15_000): Promise<boolean> {
  const abort = aborts.get(versionId);
  const job = jobs.get(versionId);
  if (!abort || !job) return false;
  abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([job.catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
  clearTimeout(timer);
  const v = await versionById(versionId);
  if (v?.state !== "draft") return true;
  const code = Object.fromEntries(Object.entries(v.code).map(([id, c]) => [id, c.status === "writing" || c.status === "reviewing" ? { ...c, status: "queued" as const } : c]));
  await updateDraft(versionId, { buildState: "idle", buildNote: STOPPED_NOTE, code });
  await setHeal(versionId, withLine({ ...(v.heal ?? emptyHeal()), question: null }, "Stopped.", "stopped"));
  return true;
}

// The job running on a draft, if any (tests wait on it).
export function jobFor(versionId: string): Promise<void> | undefined {
  return jobs.get(versionId);
}

// Every failure of a build is kept as a diagnosis (diagnosis.ts) on the
// draft's heal log, for the fixer and the details view.
export async function diagnosed(versionId: string, diagnosis: Diagnosis): Promise<void> {
  const v = await versionById(versionId);
  if (v) await setHeal(versionId, withDiagnosis(v.heal, diagnosis));
}

// A step the planner made that the safety guard would block every run:
// left out of the plan, and the maker told which and why.
async function leftOut(versionId: string, dropped: { title: string; reason: string }[]): Promise<void> {
  for (const d of dropped) await healOf(versionId, (l) => withLine(l, `Left out "${d.title}": the safety check would stop it every run. ${d.reason}`.trim(), "fixed"));
}

async function healOf(versionId: string, f: (log: HealLog) => HealLog): Promise<HealLog | null> {
  const v = await versionById(versionId);
  if (!v) return null;
  const next = f(v.heal ?? emptyHeal());
  await setHeal(versionId, next);
  return next;
}

export interface BuildContext {
  userId: string;
  conversationId: string | null;
  // SERV on the maker's own key: its calls are theirs.
  ownKey: boolean;
  // SERV only: it plans, decides and reviews, and writes code when Dolphin
  // fails twice on a step. Otherwise Dolphin writes the code.
  serv: ModelConfig;
  // The build's draft, when its model calls count towards its budget.
  versionId?: string;
  // Rules learned from earlier builds, for the planner, Dolphin and the
  // fixer (lessons.ts).
  lessons?: string[];
  // The maker's time zone, as their browser gave it: a test's local time.
  timeZone?: string | null;
  // The job's stop (stopBuild): every model call it makes ends with it.
  signal?: AbortSignal;
}

// The context a job runs in: its draft, the rules learned so far, and its
// stop.
async function jobContext(ctx: BuildContext, versionId: string): Promise<BuildContext> {
  return { ...ctx, versionId, lessons: ctx.lessons ?? (await recurringRules().catch(() => [])), signal: ctx.signal ?? aborts.get(versionId)?.signal };
}

// Only SERV, whatever else is set up.
export function servOnly(config: ModelConfig): ModelConfig {
  return { ...config, providers: config.providers.filter((p) => p.id === "serv") };
}

// How often SERV wrote a code step because Dolphin failed twice on it: its
// code calls that answered, in the last 30 days and in all.
export async function codeFallbacks(now: Date = new Date()): Promise<{ last30Days: number; total: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      recent: sql<number>`count(*) filter (where ${replyUsage.createdAt} >= ${new Date(now.getTime() - 30 * 86_400_000).toISOString()}::timestamptz)::int`,
    })
    .from(replyUsage)
    .where(and(eq(replyUsage.kind, "agent_code"), eq(replyUsage.provider, "serv"), eq(replyUsage.outcome, "ok")));
  return { last30Days: row?.recent ?? 0, total: row?.total ?? 0 };
}

export type AgentCallKind = "agent_plan" | "agent_code" | "agent_review" | "agent_decision" | "agent_guard" | "agent_screen" | "agent_vetting";

export interface CallRecord {
  provider: string | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalMs: number;
  outcome: "ok" | "fell_back" | "failed";
}

// What one call cost, in US dollars, by its provider's price.
export function callCost(call: Pick<CallRecord, "provider" | "promptTokens" | "completionTokens">): number {
  const prices = modelPrices();
  const price = prices[(call.provider ?? "serv") as keyof typeof prices] ?? prices.serv;
  return ((call.promptTokens ?? 0) * price.input + (call.completionTokens ?? 0) * price.output) / 1_000_000;
}

// One usage row per model call, like a reply's, so building and testing
// agents counts towards the day's spend, and each of its tries in the
// attempt log; and towards the build's own budget. A failure to record
// never stops the build.
export async function recordAgentCall(ctx: Pick<BuildContext, "userId" | "conversationId" | "ownKey" | "versionId">, kind: AgentCallKind, call: CallRecord | JsonResult, ownKey = ctx.ownKey): Promise<void> {
  if ("attempts" in call) await recordAttempts(db as never, call.attempts, { ownKey });
  try {
    await db.insert(replyUsage).values({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      kind,
      ownKey,
      provider: call.provider,
      model: call.model,
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      totalMs: call.totalMs,
      outcome: call.outcome,
    });
    if (ctx.versionId) {
      const cost = callCost(call);
      if (cost > 0) await healOf(ctx.versionId, (log) => ({ ...log, costUsd: Math.round(((log.costUsd ?? 0) + cost) * 1e6) / 1e6 }));
    }
  } catch (err) {
    console.error("agent usage not recorded", errorText(err, "unknown error"));
  }
}

// A new plan's code: a code step that asks for exactly what it asked for
// before keeps its code; any other is written again. Other kinds have none.
export function carryCode(definition: AgentDefinition, before: Record<string, StepCode>): Record<string, StepCode> {
  const out: Record<string, StepCode> = {};
  for (const step of definition.steps) {
    if (step.kind !== "code") continue;
    const spec = codeSpec(step);
    const old = before[step.id];
    out[step.id] = old && old.spec === spec && old.status === "approved" ? old : { spec, status: "queued", source: null, rounds: 0, note: null, updatedAt: new Date().toISOString() };
  }
  return out;
}

// How a step's writing reports back: each step's progress for the dock, and
// every call for the usage records. Dolphin runs on the site's key, whoever
// is building; SERV (its reviews, and code it writes when Dolphin can't) on
// the builder's. A review is the platform's own call, metered against its
// budget.
function writeHooks(version: AgentVersion, step: CodeStepDef, spec: string, ctx: BuildContext) {
  return {
    progress: async (status: "writing" | "reviewing", round: number) => {
      await setStepCode(version.id, step.id, { spec, status, source: null, rounds: round, note: null, updatedAt: new Date().toISOString() });
    },
    record: async (kind: "agent_code" | "agent_review", call: Parameters<typeof recordAgentCall>[2]) => {
      await recordAgentCall(ctx, kind, call, kind === "agent_code" && call.provider === "dolphin" ? false : ctx.ownKey);
      if (kind === "agent_review" && "attempts" in call) await meterPlatform(db as never, { purpose: "code_review", userId: ctx.userId, agentId: version.agentId, call, ownKey: ctx.ownKey }).catch(() => undefined);
    },
    reviewRoom: () => platformRoom(db as never, ctx.ownKey),
  };
}

// A step whose code calls other tools than the plan listed: the plan is
// changed to match (code.ts fitTools), and the code's spec with it, so the
// list never disagrees with the code.
async function fitPlan(versionId: string, definition: AgentDefinition, step: CodeStepDef, entry: StepCode): Promise<{ definition: AgentDefinition; entry: StepCode }> {
  if (!entry.tools) return { definition, entry };
  const { tools, ...rest } = entry;
  const fitted: CodeStepDef = { ...step, tools };
  const next = { ...definition, steps: definition.steps.map((s) => (s.id === step.id ? fitted : s)) };
  await updateDraft(versionId, { definition: next });
  return { definition: next, entry: { ...rest, spec: codeSpec(fitted) } };
}

// What changing a plan starts from: the maker's interview and the
// conversation behind it (when the agent has one), the plan as it is and
// what should change.
export async function planInputFor(conversationId: string | null, current: AgentDefinition | null, feedback: string): Promise<PlanInput> {
  const sketch = conversationId ? await loadSketch(conversationId) : null;
  const history = conversationId
    ? await db.select({ role: messages.role, content: messages.content }).from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt))
    : [];
  const interview = sketch ?? { name: current?.name ?? null, kind: "agent" as const, watches: null, when: null, how: null, tells: null, takes: null, does: null, gives: null, asking: null, live: false };
  return { interview, history, current, feedback: feedback || null };
}

// How a build goes on once its code is written. heal: false leaves a
// failure for the maker, as it was found (the agent page's developer
// view); otherwise it heals itself first. In the chat (journey.ts) the
// cards follow it: one as the test starts (onTest), what comes after once
// it passes (onTested), and a question the fixer has for the maker
// (onAsk, which says the message that asks it).
export interface Settle {
  heal?: boolean;
  onTest?: () => Promise<void>;
  onTested?: (result: TestResult) => Promise<void>;
  onAsk?: (question: { text: string; choices: string[] }) => Promise<string | null>;
}

// What writing and testing came to.
type Outcome = { kind: "passed"; result: TestResult } | { kind: "failed"; diagnosis: Diagnosis } | { kind: "stopped" };

// Write each code step that has no approved code, one at a time: Dolphin
// writes, SERV reviews (code.ts). A step whose code is held is diagnosed,
// the first one coming back. Null when the draft changed meanwhile.
async function writeCode(versionId: string, definition: AgentDefinition, ctx: BuildContext, o: { hints?: Record<string, string>; fetchImpl?: typeof fetch; rounds?: number; writer?: "serv" } = {}): Promise<{ definition: AgentDefinition; held: Diagnosis | null } | null> {
  const version = await versionById(versionId);
  if (!version) return null;
  const dolphin = dolphinProvider();
  const todo = definition.steps.filter((s): s is CodeStepDef => s.kind === "code" && version.code[s.id]?.status !== "approved");
  let current = definition;
  let held: Diagnosis | null = null;
  for (const step of todo) {
    if (ctx.signal?.aborted) return null;
    const spec = codeSpec(step);
    if (!dolphin && o.writer !== "serv") {
      const entry: StepCode = { spec, status: "needs_attention", source: null, rounds: 0, note: "Code writing isn't set up here.", updatedAt: new Date().toISOString() };
      await setStepCode(versionId, step.id, entry);
      held ??= codeDiagnosis(current, step.id, entry);
      continue;
    }
    const written = await writeStep(step, current, spec, { dolphin, serv: ctx.serv, fetchImpl: o.fetchImpl, hooks: writeHooks(version, step, spec, ctx), hint: o.hints?.[step.id], rounds: o.rounds, writer: o.writer, lessons: ctx.lessons, signal: ctx.signal });
    if (ctx.signal?.aborted) return null;
    const fit = await fitPlan(versionId, current, step, written);
    current = fit.definition;
    // A draft published or replanned meanwhile stops the writing.
    if (!(await setStepCode(versionId, step.id, fit.entry))) return null;
    if (fit.entry.status === "needs_attention") {
      const dx = codeDiagnosis(current, step.id, fit.entry);
      await diagnosed(versionId, dx);
      held ??= dx;
    }
  }
  return { definition: current, held };
}

// The self test on the draft as it is now (test.ts: its sample, one item
// or three, and the checks that fit it), kept as its last test with its
// sample as the test bench. The sample's call also puts each step in plain
// words, for the plain view: they go on the plan (what a step does is
// unchanged).
async function testDraft(versionId: string, ctx: BuildContext, settle: Settle, o: { sampleNote?: string | null } = {}): Promise<Outcome> {
  const now = await versionById(versionId);
  if (!now?.definition || now.definition.steps.some((s) => s.kind === "code" && now.code[s.id]?.status !== "approved")) return { kind: "stopped" };
  try {
    await settle.onTest?.();
    const tested = await selfTest(
      { definition: now.definition, code: now.code, testResult: now.testResult },
      { serv: ctx.serv, record: (call) => recordAgentCall(ctx, "agent_plan", call), sampleNote: o.sampleNote, timeZone: ctx.timeZone, signal: ctx.signal },
    );
    const plain = tested.plain ?? {};
    const definition = Object.keys(plain).length ? { ...now.definition, steps: now.definition.steps.map((s) => (plain[s.id] && !s.plain ? { ...s, plain: plain[s.id] } : s)) } : undefined;
    const result = tested.result;
    await updateDraft(versionId, { testResult: result, bench: tested.bench, ...(definition ? { definition } : {}) });
    if (result.status === "passed") return { kind: "passed", result };
    const dx = testDiagnosis(definition ?? now.definition, result, result.problems[0]?.check === "said_no" && tested.noRun ? tested.noRun : tested.events, now.code);
    await diagnosed(versionId, dx);
    return { kind: "failed", diagnosis: dx };
  } catch (err) {
    console.error(`agents: the self test stopped: ${errorText(err, "unknown error")}`);
    return { kind: "stopped" };
  }
}

// Write what isn't written, then test.
async function writeAndTest(versionId: string, definition: AgentDefinition, ctx: BuildContext, settle: Settle, o: { hints?: Record<string, string>; fetchImpl?: typeof fetch; writer?: "serv" } = {}): Promise<Outcome> {
  const written = await writeCode(versionId, definition, ctx, o);
  if (!written) return { kind: "stopped" };
  if (written.held) return { kind: "failed", diagnosis: written.held };
  return testDraft(versionId, ctx, settle);
}

// How a build ends: a pass goes on (Connect, in the chat); a failure heals
// itself (or, with heal off, waits for the maker as it was found); a build
// that stopped part way just rests.
async function settleBuild(versionId: string, ctx: BuildContext, settle: Settle, outcome: Outcome, input?: PlanInput): Promise<void> {
  if (outcome.kind === "passed") {
    await updateDraft(versionId, { buildState: "idle", buildNote: null });
    await settle.onTested?.(outcome.result);
    return;
  }
  if (outcome.kind === "failed" && settle.heal !== false) return heal(versionId, ctx, settle, { diagnosis: outcome.diagnosis }, input);
  const now = await versionById(versionId);
  const attention = Object.values(now?.code ?? {}).filter((c) => c.status === "needs_attention").length;
  await updateDraft(versionId, { buildState: "idle", buildNote: attention ? `${attention} ${attention === 1 ? "step needs" : "steps need"} your attention.` : null });
}

// What the fixer has been through on this build, for it not to try the
// same thing twice.
function triedOf(log: HealLog): string[] {
  return log.rounds
    .slice(log.since ?? 0)
    .filter((r) => r.verdict)
    .map((r) => `${r.verdict}: ${r.repair || r.why}${r.outcome === "rejected" ? ` (turned down: ${r.rejected ?? "it weakened what keeps the agent safe"})` : ""}`);
}

const interviewText = (input: PlanInput | null): string | null =>
  input
    ? [input.interview.name ? `Agent: ${input.interview.name}` : "", ...input.history.filter((m) => m.role === "user").map((m) => `Maker: ${m.content}`)].filter(Boolean).join("\n").slice(0, 3000)
    : null;

type Start = { diagnosis: Diagnosis } | { answer: string };

// The repair rounds. Each round the fixer reads the latest diagnosis and
// says what was wrong; the repair is made (a step's brief written again
// and its code with it, the steps changed, a better sample, or a question
// for the maker) and the build goes on from there. It ends when the build
// passes, when it waits for the maker's answer, or when the rounds or the
// build's model budget run out, saying in one plain sentence what it
// couldn't do. A plan that never came together (input, with no steps yet)
// heals the same way, and once it does, goes on as planning would.
async function heal(versionId: string, ctx: BuildContext, settle: Settle, start: Start, input?: PlanInput, after?: PlanOptions): Promise<void> {
  const c = await jobContext(ctx, versionId);
  let diagnosis = "diagnosis" in start ? start.diagnosis : null;
  let answer = "answer" in start ? start.answer : null;
  // What the maker said, for the fixer to read beside the diagnosis.
  const said = interviewText(input ?? (ctx.conversationId ? await planInputFor(ctx.conversationId, null, "") : null));
  for (;;) {
    if (c.signal?.aborted) return;
    const v = await versionById(versionId);
    if (!v) return;
    const log = v.heal ?? emptyHeal();
    const limits = healLimits(v.definition);
    const dx = diagnosis ?? log.rounds.at(-1)?.diagnosis ?? (answer ? planDiagnosis([], v.definition) : null);
    if (!dx) return;
    const planning = !v.definition;
    if (!answer && (roundsUsed(log) >= limits.rounds || (log.costUsd ?? 0) >= limits.costUsd)) return giveUp(versionId, dx, v.definition, Boolean(planning));
    await updateDraft(versionId, { buildState: "fixing", buildNote: null });

    // SERV or Dolphin not answering isn't something to fix: the step is
    // written again as it was, once; then it stops, saying so.
    if (!answer && dx.stage === "plan" && /No model answered/.test(dx.failure)) return giveUp(versionId, dx, v.definition, planning, NOT_ANSWERING);
    if (!answer && dx.stage === "code" && INFRA.test(dx.failure)) {
      if (log.rounds.slice(log.since ?? 0).some((r) => r.repair === RETRIED)) return giveUp(versionId, { ...dx, failure: dx.failure }, v.definition, planning, NOT_ANSWERING);
      await healOf(versionId, (l) => withLine(withRound(l, { verdict: "code", why: "SERV or Dolphin didn't answer.", repair: RETRIED }), "Checking that step again.", "working"));
      const again = await writeAndTest(versionId, v.definition!, c, settle);
      if (again.kind === "passed") {
        await healOf(versionId, (l) => withLine(markFixed(l), "Fixed.", "fixed"));
        await updateDraft(versionId, { buildState: "idle", buildNote: null });
        await settle.onTested?.(again.result);
        return;
      }
      if (again.kind === "stopped") return void (await updateDraft(versionId, { buildState: "idle", buildNote: null }));
      await healOf(versionId, (l) => markFailed(l));
      diagnosis = again.diagnosis;
      continue;
    }

    let verdict: FixVerdict | null;
    const theirs = Boolean(answer);
    if (answer) {
      // The maker answered the question: their answer is a change to the
      // steps, made with it.
      const q = log.question?.text ?? "";
      verdict = { verdict: "plan_wrong", step: null, why: `The maker was asked "${q}" and answered "${answer}".`, spec: "", change: `The maker was asked "${q}" They answered "${answer}". Change only what this answer needs.`, sample: "", question: "", choices: [], lesson: "", kind: "setup" };
      const a = answer;
      await healOf(versionId, (l) => withLine(withDiagnosis(withRound({ ...l, question: null }, { repair: `Asked: ${q} They answered: ${a}` }), dx), "Thanks. Carrying on with that.", "working"));
      answer = null;
    } else {
      await healOf(versionId, (l) => withLine(l, foundLine(dx, v.definition), "working"));
      const asked = await askFixer(dx, ctx.serv, { tried: triedOf(log), interview: said, lessons: c.lessons, signal: c.signal });
      await recordAgentCall(c, "agent_plan", asked.call);
      verdict = asked.verdict;
    }
    if (!verdict) {
      await healOf(versionId, (l) => withRound(l, { verdict: null, why: "The fixer couldn't say what was wrong.", outcome: "failed" }));
      return giveUp(versionId, dx, v.definition, planning);
    }
    // A verdict that doesn't fit where it failed is a change to the steps:
    // before there are steps, or for a step that isn't code.
    let kind = verdict.verdict;
    const stepId = verdict.step ?? dx.step?.id ?? null;
    const step = v.definition?.steps.find((s) => s.id === stepId);
    if (kind !== "unclear" && planning) kind = "plan_wrong";
    if (kind === "code_wrong" && step?.kind !== "code") kind = "plan_wrong";
    if (kind === "test_wrong" && dx.stage !== "test") kind = "plan_wrong";
    const change = verdict.change || (verdict.spec && stepId ? `Step "${stepId}": ${verdict.spec}` : verdict.why);
    const round = { why: verdict.why, lesson: verdict.lesson ? { kind: verdict.kind, text: verdict.lesson } : null };

    if (kind === "unclear") {
      const question = { text: verdict.question, choices: verdict.choices };
      await healOf(versionId, (l) => withLine(withRound(l, { ...round, verdict: "unclear", repair: `Asked: ${question.text}`, outcome: "asked" }), "I need to ask you one thing.", "asked"));
      const messageId = (await settle.onAsk?.(question)) ?? null;
      await healOf(versionId, (l) => ({ ...l, question: { ...question, messageId } }));
      await updateDraft(versionId, { buildState: planning ? "failed" : "idle", buildNote: planning ? question.text : null });
      return;
    }

    let outcome: Outcome;
    if (kind === "test_wrong") {
      await healOf(versionId, (l) => withLine(withRound(l, { ...round, verdict: "test", repair: `A new sample: ${verdict.sample || verdict.why}` }), repairLine("test", v.definition, null), "working"));
      outcome = await testDraft(versionId, c, settle, { sampleNote: verdict.sample || verdict.why });
    } else if (kind === "code_wrong" && v.definition && step?.kind === "code") {
      // The step's brief, written again by the fixer; its code from that,
      // with what was wrong beside it.
      const next: AgentDefinition = { ...v.definition, steps: v.definition.steps.map((s) => (s.id === step.id && s.kind === "code" ? { ...s, description: verdict!.spec } : s)) };
      const unsafe = weakens(v.definition, next, { failed: dx.evidence.check });
      if (unsafe) {
        await turnedDown(versionId, { ...round, verdict: "code", repair: `Step "${step.id}" written again from: ${verdict.spec}` }, unsafe, dx);
        diagnosis = dx;
        continue;
      }
      await updateDraft(versionId, { definition: next, code: carryCode(next, v.code), buildState: "writing" });
      await healOf(versionId, (l) => withLine(withRound(l, { ...round, verdict: "code", repair: `Step "${step.id}" written again from: ${verdict!.spec}` }), repairLine("code", v.definition, step.id), "working"));
      outcome = await writeAndTest(versionId, next, c, settle, { hints: { [step.id]: dx.evidence.review ?? dx.failure } });
    } else {
      await healOf(versionId, (l) => withLine(withRound(l, { ...round, verdict: "plan", repair: change }), repairLine("plan", v.definition, null), "working"));
      const base = input ?? (await planInputFor(ctx.conversationId, v.definition, ""));
      const plan = await planAgent({ ...base, current: v.definition, feedback: change }, { config: ctx.serv, signal: c.signal ?? new AbortController().signal, maxCalls: planCallCap(v.definition), lessons: c.lessons });
      for (const call of plan.calls) await recordAgentCall(c, "agent_plan", call);
      await leftOut(versionId, plan.dropped);
      if (!plan.definition) {
        const failed = planDiagnosis(plan.errors, v.definition);
        await healOf(versionId, (l) => withRound(l, { outcome: "failed" }));
        await diagnosed(versionId, failed);
        diagnosis = failed;
        continue;
      }
      if (planning) {
        // The plan came together: on as planning goes.
        await updateDraft(versionId, { definition: plan.definition, code: carryCode(plan.definition, v.code), testResult: null });
        const fixed = await healOf(versionId, (l) => withLine(withRound(l, { outcome: "fixed" }), "Fixed.", "fixed"));
        await learned(fixed, ctx.userId);
        await after?.planned?.(null, plan.definition, null);
        const stop = typeof after?.stop === "function" ? after.stop(null, plan.definition) : Boolean(after?.stop);
        if (stop) return void (await updateDraft(versionId, { buildState: "idle", buildNote: null }));
        await updateDraft(versionId, { buildState: "writing" });
        outcome = await writeAndTest(versionId, plan.definition, c, settle);
        if (outcome.kind === "failed") {
          diagnosis = outcome.diagnosis;
          input = undefined;
          continue;
        }
        return settleBuild(versionId, c, settle, outcome);
      }
      // A repair keeps the run's limits as they were, and is turned down if
      // it weakens anything else that keeps the agent safe (guarded.ts).
      const next: AgentDefinition = { ...plan.definition, limits: v.definition!.limits };
      const unsafe = weakens(v.definition!, next, { failed: dx.evidence.check, theirs });
      if (unsafe) {
        await turnedDown(versionId, {}, unsafe, dx);
        diagnosis = dx;
        continue;
      }
      const saved = await updateDraft(versionId, { definition: next, code: carryCode(next, v.code), buildState: "writing", testResult: null });
      if (!saved) return;
      outcome = await writeAndTest(versionId, next, c, settle);
    }

    if (outcome.kind === "passed") {
      const fixed = await healOf(versionId, (l) => withLine(markFixed(l), "Fixed.", "fixed"));
      await learned(fixed, ctx.userId);
      await updateDraft(versionId, { buildState: "idle", buildNote: null });
      await settle.onTested?.(outcome.result);
      return;
    }
    if (outcome.kind === "stopped") {
      await healOf(versionId, (l) => withRound(l, { outcome: "failed" }));
      await updateDraft(versionId, { buildState: "idle", buildNote: null });
      return;
    }
    // The round didn't fix it: the new failure is the next round's.
    await healOf(versionId, (l) => markFailed(l));
    diagnosis = outcome.diagnosis;
  }
}

// The round that fixed it, as a lesson (lessons.ts): its rule, what went
// wrong and what fixed it. A lesson that can't be kept never stops a build.
async function learned(log: HealLog | null, makerId: string): Promise<void> {
  const round = [...(log?.rounds ?? [])].reverse().find((r) => r.outcome === "fixed");
  if (!round?.lesson?.text) return;
  await learn({ kind: round.lesson.kind, rule: round.lesson.text, wrong: round.diagnosis.failure, fix: round.repair || round.why, makerId }).catch((err) => console.error(`agents: a lesson wasn't kept: ${errorText(err, "unknown error")}`));
}

// A repair that would weaken what keeps the agent safe is turned down:
// nothing of it is kept, and the next round starts from the same failure.
async function turnedDown(versionId: string, patch: Partial<HealRound>, why: string, dx: Diagnosis): Promise<void> {
  await healOf(versionId, (l) => withLine(withDiagnosis(withRound(l, { ...patch, outcome: "rejected", rejected: why }), dx), "Trying another way.", "working"));
}

// The round acted on, once its build came back: failed, or fixed (a new
// diagnosis may have come after it).
function marked(log: HealLog, outcome: "failed" | "fixed"): HealLog {
  const rounds = [...log.rounds];
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i]!.outcome !== "pending" || rounds[i]!.verdict === null) continue;
    rounds[i] = { ...rounds[i]!, outcome };
    break;
  }
  return { ...log, rounds };
}
const markFailed = (log: HealLog) => marked(log, "failed");
const markFixed = (log: HealLog) => marked(log, "fixed");

// A step held because no model answered, not because of what it is.
const INFRA = /couldn't review it just now|didn't answer|isn't set up here/i;
const RETRIED = "Written again as it was: SERV or Dolphin didn't answer.";
const NOT_ANSWERING = "SERV isn't answering just now, so it stopped part way. Try again in a few minutes.";

// Out of rounds or budget: one plain sentence of what it couldn't do, for
// the card to show with its two choices.
async function giveUp(versionId: string, dx: Diagnosis, d: AgentDefinition | null, planning: boolean, said?: string): Promise<void> {
  const text = said ?? gaveUpLine(dx, d);
  await healOf(versionId, (l) => withLine({ ...l, gaveUp: text }, text, "stopped"));
  await updateDraft(versionId, { buildState: planning ? "failed" : "idle", buildNote: planning ? text : null });
}

// The maker answered the fixer's question: the build goes on with it, in
// the background. False when a job is already running on the draft.
export function answerQuestion(version: AgentVersion, answer: string, ctx: BuildContext, settle: Settle = {}, after?: PlanOptions): boolean {
  if (jobs.has(version.id) || !version.heal?.question) return false;
  const abort = begin(version.id);
  const job = (async () => {
    try {
      const input = version.definition ? undefined : await planInputFor(ctx.conversationId, null, "");
      await heal(version.id, ctx, settle, { answer }, input, after);
    } catch (err) {
      // Stopped by the maker: stopBuild settles the draft.
      if (abort.signal.aborted) return;
      console.error(`agents: healing stopped: ${errorText(err, "unknown error")}`);
      await updateDraft(version.id, { buildState: version.definition ? "idle" : "failed", buildNote: version.definition ? null : "Something went wrong while building. Try again." }).catch(() => null);
    }
  })();
  track(version.id, abort, job);
  return true;
}

// A failure found outside a build (the review before going live): it heals
// in the background like one. False when a job is already running.
export function startHeal(version: AgentVersion, diagnosis: Diagnosis, ctx: BuildContext, settle: Settle = {}): boolean {
  if (jobs.has(version.id)) return false;
  const abort = begin(version.id);
  const job = (async () => {
    try {
      await setHeal(version.id, freshBuild((await versionById(version.id))?.heal));
      await diagnosed(version.id, diagnosis);
      await heal(version.id, ctx, settle, { diagnosis });
    } catch (err) {
      // Stopped by the maker: stopBuild settles the draft.
      if (abort.signal.aborted) return;
      console.error(`agents: healing stopped: ${errorText(err, "unknown error")}`);
      await updateDraft(version.id, { buildState: "idle", buildNote: null }).catch(() => null);
    }
  })();
  track(version.id, abort, job);
  return true;
}

// Once a plan is saved: write each code step that has no approved code,
// one at a time, Dolphin writing and SERV reviewing (code.ts), then test
// it, healing what fails. The dock sees each step's progress as it goes.
export async function writeAllCode(version: AgentVersion, definition: AgentDefinition, ctx: BuildContext, fetchImpl?: typeof fetch, settle: Settle = {}): Promise<void> {
  const c = await jobContext(ctx, version.id);
  const outcome = await writeAndTest(version.id, definition, c, settle, { fetchImpl });
  await settleBuild(version.id, c, settle, outcome);
}

// "Fix this" on a step on hold: SERV writes its code again from the start
// (its review still a call of its own), in the background like a build.
// False when a job is already running on the draft, or there's no such
// code step.
export function startRewrite(version: AgentVersion, stepId: string, ctx: BuildContext, fetchImpl?: typeof fetch, settle: Settle = {}): boolean {
  const definition = version.definition;
  const step = definition?.steps.find((s): s is CodeStepDef => s.id === stepId && s.kind === "code");
  if (!definition || !step || jobs.has(version.id)) return false;
  const abort = begin(version.id);
  const job = (async () => {
    await updateDraft(version.id, { buildState: "writing", buildNote: null, code: { ...version.code, [step.id]: { ...(version.code[step.id] ?? { spec: codeSpec(step), source: null, rounds: 0, note: null, updatedAt: new Date().toISOString() }), status: "queued" } } });
    await setHeal(version.id, freshBuild(version.heal));
    try {
      const c = await jobContext(ctx, version.id);
      const outcome = await writeAndTest(version.id, definition, c, settle, { fetchImpl, writer: "serv" });
      await settleBuild(version.id, c, settle, outcome);
    } catch (err) {
      // Stopped by the maker: stopBuild settles the draft.
      if (abort.signal.aborted) return;
      console.error(`agents: a rewrite stopped: ${errorText(err, "unknown error")}`);
      await updateDraft(version.id, { buildState: "idle", buildNote: "Rewriting that step stopped part way. Try again." }).catch(() => null);
    }
  })();
  track(version.id, abort, job);
  return true;
}

const NO_MODEL = "Working out the steps isn't available right now. Try again in a few minutes.";

// Planning in the chat (journey.ts) stops once the steps are there, for
// the maker to look at: stop says whether it does (a change that touches
// the maker's own numbers, conditions or schedule stops to ask). planned
// hears how it went first, with the steps before and after (null when no
// plan came of it), and settle is how the build after it goes on.
export interface PlanOptions {
  stop?: boolean | ((before: AgentDefinition | null, after: AgentDefinition) => boolean);
  planned?: (before: AgentDefinition | null, after: AgentDefinition | null, why: string | null) => Promise<void>;
  settle?: Settle;
}

// Plan (or change the plan of) a draft in the background. False when a job
// is already running on it.
export function startPlan(version: AgentVersion, input: PlanInput, ctx: BuildContext, mode: "plan" | "fix" = "plan", o: PlanOptions = {}): boolean {
  if (jobs.has(version.id)) return false;
  const settle = o.settle ?? {};
  const abort = begin(version.id);
  const job = (async () => {
    await updateDraft(version.id, { buildState: mode === "fix" ? "fixing" : "planning", buildNote: null });
    await setHeal(version.id, freshBuild(version.heal));
    const c = await jobContext(ctx, version.id);
    try {
      const plan = await planAgent(input, { config: ctx.serv, signal: c.signal ?? new AbortController().signal, lessons: c.lessons, ...(version.definition ? { maxCalls: planCallCap(version.definition) } : {}) });
      if (c.signal?.aborted) return;
      for (const call of plan.calls) await recordAgentCall(c, "agent_plan", call);
      await leftOut(version.id, plan.dropped);
      if (!plan.definition) {
        const failures = plan.calls.flatMap((x) => x.failures);
        const answered = plan.calls.some((x) => x.content);
        console.error(`agents: no plan. ${answered ? plan.errors.join(" ") : describeFailures(failures, ctx.serv.firstTokenTimeoutMs)}`);
        // A plan that didn't check out heals; one no model answered can't.
        if (answered && !version.definition && settle.heal !== false) {
          const dx = planDiagnosis(plan.errors, null);
          await diagnosed(version.id, dx);
          return heal(version.id, c, settle, { diagnosis: dx }, input, o);
        }
        if (answered) await diagnosed(version.id, planDiagnosis(plan.errors, version.definition));
        // Why, in plain words, and what to add (plainWords.ts): the
        // checker's own reasons name steps by id, so they stay in the log.
        const why = answered ? planFailure(plan.errors) : NO_MODEL;
        // A change that didn't come together in the chat leaves the steps
        // as they were, and says so; anything else is a failed build.
        if (o.planned && version.definition) await updateDraft(version.id, { buildState: "idle", buildNote: null });
        else await updateDraft(version.id, { buildState: "failed", buildNote: why });
        await o.planned?.(version.definition, null, why);
        return;
      }
      const stop = typeof o.stop === "function" ? o.stop(version.definition, plan.definition) : Boolean(o.stop);
      const saved = await updateDraft(version.id, { definition: plan.definition, code: carryCode(plan.definition, version.code), buildState: stop ? "idle" : "writing", testResult: null });
      await o.planned?.(version.definition, plan.definition, null);
      if (saved && !stop) await writeAllCode(saved, plan.definition, c, undefined, settle);
    } catch (err) {
      // Stopped by the maker: stopBuild settles the draft.
      if (abort.signal.aborted) return;
      console.error(`agents: the build stopped: ${errorText(err, "unknown error")}`);
      await updateDraft(version.id, { buildState: "failed", buildNote: "Something went wrong while building. Try again." }).catch(() => null);
    }
  })();
  track(version.id, abort, job);
  return true;
}

// Build a draft whose steps the maker has looked at: each code step without
// approved code is written and checked, then the self test. False when a
// job is already running on it.
export function startBuild(version: AgentVersion, ctx: BuildContext, settle?: Settle): boolean {
  const definition = version.definition;
  if (!definition || jobs.has(version.id)) return false;
  const abort = begin(version.id);
  const job = (async () => {
    const saved = await updateDraft(version.id, { buildState: "writing", buildNote: null });
    await setHeal(version.id, freshBuild(version.heal));
    try {
      if (saved) await writeAllCode(saved, definition, ctx, undefined, settle);
    } catch (err) {
      // Stopped by the maker: stopBuild settles the draft.
      if (abort.signal.aborted) return;
      console.error(`agents: the build stopped: ${errorText(err, "unknown error")}`);
      await updateDraft(version.id, { buildState: "failed", buildNote: "Something went wrong while building. Try again." }).catch(() => null);
    }
  })();
  track(version.id, abort, job);
  return true;
}

const BUSY = ["planning", "writing", "fixing"];

// A draft whose build no job in this process owns (the server restarted
// part way) is called failed, so the maker can start again.
export async function settle(version: AgentVersion): Promise<AgentVersion> {
  if (version.state !== "draft" || !BUSY.includes(version.buildState) || jobs.has(version.id)) return version;
  return (await updateDraft(version.id, { buildState: "failed", buildNote: "The build stopped part way. Try again." })) ?? version;
}

// What the maker's dock may see: the steps' shape and the build's progress,
// never code or prompts.
export function summaryOf(agent: Agent, version: AgentVersion): AgentSummaryDTO {
  const steps = version.definition?.steps ?? [];
  const heal = version.heal;
  return {
    id: agent.id,
    version: version.number,
    state: version.state,
    buildState: version.buildState,
    buildNote: version.buildNote,
    steps: steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, next: nextOf(s), code: s.kind === "code" ? (version.code[s.id]?.status ?? "queued") : null })),
    test: version.testResult ? { status: version.testResult.status, story: version.testResult.story, checkedAt: version.testResult.checkedAt, fixed: version.testResult.fixed ?? null } : null,
    problem: problemOf(version),
    plain: plainSteps(version.definition),
    setup: version.definition ? { ...setupShapeOf(version.definition), given: givenAnswers(version.definition) } : null,
    does: version.definition?.job.does ?? null,
    heal: heal ? { lines: heal.lines.map(({ text, tone, at }) => ({ text, tone, at })), question: heal.question ? { text: heal.question.text, choices: heal.question.choices, messageId: heal.question.messageId ?? null } : null, gaveUp: heal.gaveUp ?? null } : null,
  };
}

// The steps in plain words, in the order a run takes them, a loop's own set
// in under it.
export function plainSteps(d: AgentDefinition | null): { id: string; text: string; depth: number }[] {
  if (!d) return [];
  const depths = stepDepths(d);
  return stepsInOrder(d).map((s) => ({ id: s.id, text: stepLine(s, d), depth: depths.get(s.id) ?? 0 }));
}
