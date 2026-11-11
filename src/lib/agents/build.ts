import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { meterPlatform, platformRoom } from "./metering";
import { replyUsage, type Agent, type AgentVersion } from "../db/schema";
import { describeFailures, type JsonResult, type ModelConfig } from "../model";
import type { AgentSummaryDTO } from "../types";
import { dolphinProvider, writeStep } from "./code";
import { codeSpec, nextOf, type AgentDefinition, type CodeStepDef } from "./definition";
import { planAgent, type PlanInput } from "./plan";
import { setStepCode, updateDraft, versionById } from "./store";
import { planFailure, problemOf } from "./plainWords";
import { selfTest } from "./test";
import type { StepCode } from "./types";
import { errorText } from "../db/errors";
import { recordAttempts } from "../modelAttempts";

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

// Once the code is written: with every step ready, the plan gets its self
// test (test.ts: three sample items, then a second run), kept as the
// draft's last test with its sample as the test bench; then the note says
// how many steps wait for the maker.
async function settleWriting(versionId: string, ctx: BuildContext): Promise<void> {
  const now = await versionById(versionId);
  const attention = Object.values(now?.code ?? {}).filter((c) => c.status === "needs_attention").length;
  if (now?.definition && !attention && now.definition.steps.every((s) => s.kind !== "code" || now.code[s.id]?.status === "approved")) {
    try {
      const tested = await selfTest(
        { definition: now.definition, code: now.code, testResult: now.testResult },
        { serv: ctx.serv, record: (call) => recordAgentCall(ctx, "agent_plan", call) },
      );
      // The sample's call also put each step in plain words, for the plain
      // view: they go on the plan (what a step does is unchanged).
      const plain = tested.plain ?? {};
      const definition = Object.keys(plain).length ? { ...now.definition, steps: now.definition.steps.map((s) => (plain[s.id] && !s.plain ? { ...s, plain: plain[s.id] } : s)) } : undefined;
      await updateDraft(versionId, { testResult: tested.result, bench: tested.bench, ...(definition ? { definition } : {}) });
    } catch (err) {
      console.error(`agents: the self test stopped: ${errorText(err, "unknown error")}`);
    }
  }
  await updateDraft(versionId, { buildState: "idle", buildNote: attention ? `${attention} ${attention === 1 ? "step needs" : "steps need"} your attention.` : null });
}

// Once a plan is saved: write each code step that has no approved code,
// one at a time, Dolphin writing and SERV reviewing (code.ts). The dock
// sees each step's progress as it goes.
export async function writeAllCode(version: AgentVersion, definition: AgentDefinition, ctx: BuildContext, fetchImpl?: typeof fetch): Promise<void> {
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
  }
  await settleWriting(version.id, ctx);
}

// "Fix this" on a step on hold: SERV writes its code again from the start
// (its review still a call of its own), in the background like a build.
// False when a job is already running on the draft, or there's no such
// code step.
export function startRewrite(version: AgentVersion, stepId: string, ctx: BuildContext, fetchImpl?: typeof fetch): boolean {
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
      await settleWriting(version.id, ctx);
    } catch (err) {
      console.error(`agents: a rewrite stopped: ${errorText(err, "unknown error")}`);
      await updateDraft(version.id, { buildState: "idle", buildNote: "Rewriting that step stopped part way. Try again." }).catch(() => null);
    }
  })().finally(() => jobs.delete(version.id));
  jobs.set(version.id, job);
  return true;
}

const NO_MODEL = "Planning isn't available right now. Try again in a few minutes.";

// Plan (or change the plan of) a draft in the background. False when a job
// is already running on it.
export function startPlan(version: AgentVersion, input: PlanInput, ctx: BuildContext, mode: "plan" | "fix" = "plan"): boolean {
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
        await updateDraft(version.id, { buildState: "failed", buildNote: plan.calls.some((c) => c.content) ? planFailure(plan.errors) : NO_MODEL });
        return;
      }
      const saved = await updateDraft(version.id, { definition: plan.definition, code: carryCode(plan.definition, version.code), buildState: "writing" });
      if (saved) await writeAllCode(saved, plan.definition, ctx);
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
  return (await updateDraft(version.id, { buildState: "failed", buildNote: "The build stopped part way. Plan it again." })) ?? version;
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
    test: version.testResult ? { status: version.testResult.status, story: version.testResult.story, checkedAt: version.testResult.checkedAt } : null,
    problem: problemOf(version),
  };
}
