import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { meterPlatform, platformRoom } from "./metering";
import { messages, replyUsage, type Agent, type AgentVersion } from "../db/schema";
import { loadSketch } from "../sketchStore";
import { describeFailures, type JsonResult, type ModelConfig } from "../model";
import type { AgentSummaryDTO } from "../types";
import { dolphinProvider, writeStep } from "./code";
import { codeSpec, givenAnswers, nextOf, setupShapeOf, type AgentDefinition, type CodeStepDef } from "./definition";
import { stepDepths, stepLine, stepsInOrder } from "./plainView";
import { planAgent, type PlanInput } from "./plan";
import { setHeal, setStepCode, updateDraft, versionById } from "./store";
import { planFailure, problemOf } from "./plainWords";
import { selfTest } from "./test";
import type { StepCode, TestResult } from "./types";
import { errorText } from "../db/errors";
import { recordAttempts } from "../modelAttempts";
import { codeDiagnosis, planDiagnosis, testDiagnosis, withDiagnosis } from "./diagnosis";
import type { Diagnosis } from "./types";

// The build: planning, then the code, runs in the background,
// because it can take longer than a request may. One job per draft at a
// time, kept in this process; the draft's build_state says where it is, and
// the builder polls it. A server restart mid-build leaves a state no job
// owns, which the next look calls failed (settle).

const jobs = new Map<string, Promise<void>>();

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

export interface BuildContext {
  userId: string;
  conversationId: string | null;
  // SERV on the maker's own key: its calls are theirs.
  ownKey: boolean;
  // SERV only: it plans, decides and reviews, and writes code when Dolphin
  // fails twice on a step. Otherwise Dolphin writes the code.
  serv: ModelConfig;
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

// One usage row per model call, like a reply's, so building and testing
// agents counts towards the day's spend, and each of its tries in the
// attempt log. A failure to record never stops the build.
export async function recordAgentCall(ctx: Pick<BuildContext, "userId" | "conversationId" | "ownKey">, kind: AgentCallKind, call: CallRecord | JsonResult, ownKey = ctx.ownKey): Promise<void> {
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
export async function planInputFor(conversationId: string | null, current: AgentDefinition, feedback: string): Promise<PlanInput> {
  const sketch = conversationId ? await loadSketch(conversationId) : null;
  const history = conversationId
    ? await db.select({ role: messages.role, content: messages.content }).from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt))
    : [];
  const interview = sketch ?? { name: current.name, kind: "agent" as const, watches: null, when: null, how: null, tells: null, takes: null, does: null, gives: null, asking: null, live: false };
  return { interview, history, current, feedback };
}

// How the self test after writing goes on: whether a failure runs Fix this
// once on its own, and the problem an earlier run of it fixed. In the chat
// (journey.ts) a failure goes to the maker instead, with a box to say
// what's wrong, and the chat's cards follow the test: one as it starts, and
// what comes after it once it is done.
export interface Settle {
  autoFix: boolean;
  fixed?: string;
  onTest?: () => Promise<void>;
  onTested?: (result: TestResult) => Promise<void>;
}

// Once the code is written: with every step ready, the plan gets its self
// test (test.ts: its sample, one item or three, and the checks that fit
// it), kept as the draft's last test with its sample as the test bench;
// then the note says how many steps wait for the maker. A self test that fails runs Fix this
// once on its own, with the one plain sentence that says what went wrong:
// the plan is changed from it, written and tested again. If that test
// fails too, the sentence stays with the Fix this button.
async function settleWriting(versionId: string, ctx: BuildContext, settle: Settle = { autoFix: true }): Promise<void> {
  const now = await versionById(versionId);
  const attention = Object.values(now?.code ?? {}).filter((c) => c.status === "needs_attention").length;
  if (now?.definition && !attention && now.definition.steps.every((s) => s.kind !== "code" || now.code[s.id]?.status === "approved")) {
    try {
      await settle.onTest?.();
      const tested = await selfTest(
        { definition: now.definition, code: now.code, testResult: now.testResult },
        { serv: ctx.serv, record: (call) => recordAgentCall(ctx, "agent_plan", call) },
      );
      // The sample's call also put each step in plain words, for the plain
      // view: they go on the plan (what a step does is unchanged).
      const plain = tested.plain ?? {};
      const definition = Object.keys(plain).length ? { ...now.definition, steps: now.definition.steps.map((s) => (plain[s.id] && !s.plain ? { ...s, plain: plain[s.id] } : s)) } : undefined;
      const result = settle.fixed ? { ...tested.result, fixed: settle.fixed } : tested.result;
      await updateDraft(versionId, { testResult: result, bench: tested.bench, ...(definition ? { definition } : {}) });
      if (result.status === "failed") await diagnosed(versionId, testDiagnosis(definition ?? now.definition, result, tested.events, now.code));
      const sentence = result.status === "failed" ? result.problems[0]?.text : undefined;
      if (sentence && settle.autoFix && (await fixOnce(versionId, ctx, definition ?? now.definition, sentence))) return;
      await updateDraft(versionId, { buildState: "idle", buildNote: null });
      await settle.onTested?.(result);
      return;
    } catch (err) {
      console.error(`agents: the self test stopped: ${errorText(err, "unknown error")}`);
    }
  }
  await updateDraft(versionId, { buildState: "idle", buildNote: attention ? `${attention} ${attention === 1 ? "step needs" : "steps need"} your attention.` : null });
}

// Fix this, run on its own after a failed self test: the plan is changed
// from the test's sentence, its changed steps written, and it is tested
// again, with no second fix on its own. While it runs, the sentence is the
// build's note. False when no plan came of it: the failed test stays.
async function fixOnce(versionId: string, ctx: BuildContext, current: AgentDefinition, sentence: string): Promise<boolean> {
  await updateDraft(versionId, { buildState: "fixing", buildNote: sentence });
  const plan = await planAgent(await planInputFor(ctx.conversationId, current, sentence), { config: ctx.serv, signal: new AbortController().signal });
  for (const call of plan.calls) await recordAgentCall(ctx, "agent_plan", call);
  const version = await versionById(versionId);
  if (!plan.definition || !version) {
    console.error(`agents: Fix this on its own made no plan. ${plan.errors.join(" ")}`);
    await diagnosed(versionId, planDiagnosis(plan.errors, current));
    return false;
  }
  const saved = await updateDraft(versionId, { definition: plan.definition, code: carryCode(plan.definition, version.code), buildState: "writing", buildNote: null });
  if (saved) await writeAllCode(saved, plan.definition, ctx, undefined, { autoFix: false, fixed: sentence });
  return true;
}

// Once a plan is saved: write each code step that has no approved code,
// one at a time, Dolphin writing and SERV reviewing (code.ts). The dock
// sees each step's progress as it goes.
export async function writeAllCode(version: AgentVersion, definition: AgentDefinition, ctx: BuildContext, fetchImpl?: typeof fetch, settle?: Settle): Promise<void> {
  const dolphin = dolphinProvider();
  const todo = definition.steps.filter((s): s is CodeStepDef => s.kind === "code" && version.code[s.id]?.status !== "approved");
  let current = definition;
  for (const step of todo) {
    const spec = codeSpec(step);
    if (!dolphin) {
      await setStepCode(version.id, step.id, { spec, status: "needs_attention", source: null, rounds: 0, note: "Code writing isn't set up here.", updatedAt: new Date().toISOString() });
      continue;
    }
    const written = await writeStep(step, current, spec, { dolphin, serv: ctx.serv, fetchImpl, hooks: writeHooks(version, step, spec, ctx) });
    const fit = await fitPlan(version.id, current, step, written);
    current = fit.definition;
    // A draft published or replanned meanwhile stops the writing.
    if (!(await setStepCode(version.id, step.id, fit.entry))) return;
    if (fit.entry.status === "needs_attention") await diagnosed(version.id, codeDiagnosis(current, step.id, fit.entry));
  }
  await settleWriting(version.id, ctx, settle);
}

// "Fix this" on a step on hold: SERV writes its code again from the start
// (its review still a call of its own), in the background like a build.
// False when a job is already running on the draft, or there's no such
// code step.
export function startRewrite(version: AgentVersion, stepId: string, ctx: BuildContext, fetchImpl?: typeof fetch, settle?: Settle): boolean {
  const definition = version.definition;
  const step = definition?.steps.find((s): s is CodeStepDef => s.id === stepId && s.kind === "code");
  if (!definition || !step || jobs.has(version.id)) return false;
  const job = (async () => {
    await updateDraft(version.id, { buildState: "writing", buildNote: null });
    try {
      const spec = codeSpec(step);
      const written = await writeStep(step, definition, spec, { dolphin: dolphinProvider(), serv: ctx.serv, fetchImpl, writer: "serv", hooks: writeHooks(version, step, spec, ctx) });
      const fit = await fitPlan(version.id, definition, step, written);
      await setStepCode(version.id, step.id, fit.entry);
      if (fit.entry.status === "needs_attention") await diagnosed(version.id, codeDiagnosis(fit.definition, step.id, fit.entry));
      await settleWriting(version.id, ctx, settle);
    } catch (err) {
      console.error(`agents: a rewrite stopped: ${errorText(err, "unknown error")}`);
      await updateDraft(version.id, { buildState: "idle", buildNote: "Rewriting that step stopped part way. Try again." }).catch(() => null);
    }
  })().finally(() => jobs.delete(version.id));
  jobs.set(version.id, job);
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
  const job = (async () => {
    await updateDraft(version.id, { buildState: mode === "fix" ? "fixing" : "planning", buildNote: null });
    try {
      const plan = await planAgent(input, { config: ctx.serv, signal: new AbortController().signal });
      for (const call of plan.calls) await recordAgentCall(ctx, "agent_plan", call);
      if (!plan.definition) {
        const failures = plan.calls.flatMap((c) => c.failures);
        console.error(`agents: no plan. ${plan.calls.some((c) => c.content) ? plan.errors.join(" ") : describeFailures(failures, ctx.serv.firstTokenTimeoutMs)}`);
        // Why, in plain words, and what to add (plainWords.ts): the
        // checker's own reasons name steps by id, so they stay in the log.
        const why = plan.calls.some((c) => c.content) ? planFailure(plan.errors) : NO_MODEL;
        await diagnosed(version.id, planDiagnosis(plan.errors, version.definition));
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
      if (saved && !stop) await writeAllCode(saved, plan.definition, ctx, undefined, o.settle);
    } catch (err) {
      console.error(`agents: the build stopped: ${errorText(err, "unknown error")}`);
      await updateDraft(version.id, { buildState: "failed", buildNote: "Something went wrong while building. Try again." }).catch(() => null);
    }
  })().finally(() => jobs.delete(version.id));
  jobs.set(version.id, job);
  return true;
}

// Build a draft whose steps the maker has looked at: each code step without
// approved code is written and checked, then the self test. False when a
// job is already running on it.
export function startBuild(version: AgentVersion, ctx: BuildContext, settle?: Settle): boolean {
  const definition = version.definition;
  if (!definition || jobs.has(version.id)) return false;
  const job = (async () => {
    const saved = await updateDraft(version.id, { buildState: "writing", buildNote: null });
    try {
      if (saved) await writeAllCode(saved, definition, ctx, undefined, settle);
    } catch (err) {
      console.error(`agents: the build stopped: ${errorText(err, "unknown error")}`);
      await updateDraft(version.id, { buildState: "failed", buildNote: "Something went wrong while building. Try again." }).catch(() => null);
    }
  })().finally(() => jobs.delete(version.id));
  jobs.set(version.id, job);
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
  };
}

// The steps in plain words, in the order a run takes them, a loop's own set
// in under it.
export function plainSteps(d: AgentDefinition | null): { id: string; text: string; depth: number }[] {
  if (!d) return [];
  const depths = stepDepths(d);
  return stepsInOrder(d).map((s) => ({ id: s.id, text: stepLine(s, d), depth: depths.get(s.id) ?? 0 }));
}
