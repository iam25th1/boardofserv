import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { replyUsage, type Agent, type AgentVersion } from "../db/schema";
import { describeFailures, type JsonResult, type ModelConfig } from "../model";
import type { AgentSummaryDTO } from "../types";
import { dolphinProvider, writeStep } from "./code";
import { codeSpec, nextOf, type AgentDefinition, type CodeStepDef } from "./definition";
import { planAgent, MAX_PLAN_TRIES, type PlanInput } from "./plan";
import { setStepCode, updateDraft, versionById } from "./store";
import type { StepCode } from "./types";

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

export type AgentCallKind = "agent_plan" | "agent_code" | "agent_review" | "agent_decision";

export interface CallRecord {
  provider: string | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalMs: number;
  outcome: "ok" | "fell_back" | "failed";
}

// One usage row per model call, like a reply's, so building and testing
// agents counts towards the day's spend. A failure to record never stops
// the build.
export async function recordAgentCall(ctx: Pick<BuildContext, "userId" | "conversationId" | "ownKey">, kind: AgentCallKind, call: CallRecord | JsonResult, ownKey = ctx.ownKey): Promise<void> {
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
    console.error("agent usage not recorded", err instanceof Error ? err.message : "unknown error");
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

// Once a plan is saved: write each code step that has no approved code,
// one at a time, Dolphin writing and SERV reviewing (code.ts). The dock
// sees each step's progress as it goes.
export async function writeAllCode(version: AgentVersion, definition: AgentDefinition, ctx: BuildContext, fetchImpl?: typeof fetch): Promise<void> {
  const dolphin = dolphinProvider();
  const todo = definition.steps.filter((s): s is CodeStepDef => s.kind === "code" && version.code[s.id]?.status !== "approved");
  for (const step of todo) {
    const spec = codeSpec(step);
    if (!dolphin) {
      await setStepCode(version.id, step.id, { spec, status: "needs_attention", source: null, rounds: 0, note: "Code writing isn't set up here.", updatedAt: new Date().toISOString() });
      continue;
    }
    const entry = await writeStep(step, definition, spec, {
      dolphin,
      serv: ctx.serv,
      fetchImpl,
      hooks: {
        progress: async (status, round) => {
          await setStepCode(version.id, step.id, { spec, status, source: null, rounds: round, note: null, updatedAt: new Date().toISOString() });
        },
        // Dolphin runs on the site's key, whoever is building; SERV (its
        // reviews, and code it writes when Dolphin can't) on the builder's.
        record: (kind, call) => recordAgentCall(ctx, kind, call, kind === "agent_code" && call.provider === "dolphin" ? false : ctx.ownKey),
      },
    });
    // A draft published or replanned meanwhile stops the writing.
    if (!(await setStepCode(version.id, step.id, entry))) return;
  }
  const now = await versionById(version.id);
  const attention = Object.values(now?.code ?? {}).filter((c) => c.status === "needs_attention").length;
  await updateDraft(version.id, { buildState: "idle", buildNote: attention ? `${attention} ${attention === 1 ? "step needs" : "steps need"} your attention.` : null });
}

const PLAN_FAILED = `The plan didn't come together after ${MAX_PLAN_TRIES} tries. Try again, or add a detail in the chat.`;
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
        await updateDraft(version.id, { buildState: "failed", buildNote: plan.calls.some((c) => c.content) ? PLAN_FAILED : NO_MODEL });
        return;
      }
      const saved = await updateDraft(version.id, { definition: plan.definition, code: carryCode(plan.definition, version.code), buildState: "writing" });
      if (saved) await writeAllCode(saved, plan.definition, ctx);
    } catch (err) {
      console.error(`agents: the build stopped: ${err instanceof Error ? err.message : "unknown error"}`);
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
  };
}
