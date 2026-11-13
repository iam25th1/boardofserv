import "server-only";
import { completeJson, type ChatMessage, type JsonResult, type ModelConfig } from "../model";
import { checkDefinition, nextOf, type AgentDefinition, type AgentStep, type ToolName } from "./definition";
import { planProblems } from "./planRules";

// The planner and the action guard agree. Before a plan is kept, every
// step that would act (send, write, pay, remember) is read by SERV the way
// the guard reads a call when the agent runs (guard.ts): does it fit what
// the agent is for? A step clearly outside it is left out of the plan, as
// the guard would block it every time it ran; the maker sees which, and
// why. A step that can't be left out without breaking the rest stays, and
// the guard decides at run time.

export interface PurposeVerdict {
  id: string;
  verdict: "fits" | "ask" | "outside";
  reason: string;
}

export const PURPOSE_SYSTEM = "You check the planned actions of an automated agent before it is built. Answer with JSON in the given schema.";

const RULES = [
  "When the agent runs, a safety guard reads each of these actions against what the agent is for and the maker's words, and answers allow, ask or block. Say now what it would say about each one, as it would for an ordinary run.",
  "fits: it plainly fits what the agent is for. ask: it might fit, but could surprise the person it runs for. outside: it is clearly outside what the agent is for, so the guard would block it.",
  "Something the maker asked for, or that the job needs to be done (keeping its place so the next run skips what it did, sending the result the maker wants), fits.",
  "Give each reason in one short plain sentence. Never use em dashes.",
].join(" ");

const SCHEMA = {
  name: "purpose_check",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["steps"],
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "verdict", "reason"],
          properties: { id: { type: "string" }, verdict: { type: "string", enum: ["fits", "ask", "outside"] }, reason: { type: "string" } },
        },
      },
    },
  },
};

// The tool a step acts with, if it acts.
function actsWith(d: AgentDefinition, s: AgentStep): ToolName | null {
  if (s.kind === "action") return d.actions.find((a) => a.id === s.action)?.tool ?? null;
  return null;
}

// The steps the guard will read when the agent runs: every action.
export function actingSteps(d: AgentDefinition): AgentStep[] {
  return d.steps.filter((s) => actsWith(d, s));
}

export function purposeRequest(d: AgentDefinition, said: string[]): string {
  const steps = actingSteps(d).map((s) => {
    const action = s.kind === "action" ? d.actions.find((a) => a.id === s.action) : undefined;
    return { id: s.id, title: s.title, does: action?.description ?? s.title, tool: actsWith(d, s) };
  });
  return [
    RULES,
    "",
    `Agent: ${d.name}`,
    `What it is for: ${d.job.does}`,
    `Done when: ${d.job.done}`,
    ...(said.length ? ["", "What the maker said:", ...said.slice(-8).map((m) => `- ${m.slice(0, 600)}`)] : []),
    "",
    "Its actions:",
    JSON.stringify(steps),
  ].join("\n");
}

export async function askPurpose(d: AgentDefinition, said: string[], serv: ModelConfig, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<JsonResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: PURPOSE_SYSTEM },
    { role: "user", content: purposeRequest(d, said) },
  ];
  const config = { ...serv, firstTokenTimeoutMs: Math.max(serv.firstTokenTimeoutMs, 30_000) };
  return completeJson(messages, { config, purpose: "guard", schema: SCHEMA, maxTokens: 120 + 60 * actingSteps(d).length, signal: opts.signal ?? new AbortController().signal, fetchImpl: opts.fetchImpl });
}

// SERV's verdicts, for the steps that act; none when it didn't answer.
export function readPurpose(d: AgentDefinition, call: JsonResult): PurposeVerdict[] {
  let raw: unknown = null;
  try {
    raw = call.content ? JSON.parse(call.content) : null;
  } catch {
    raw = null;
  }
  const list = raw && typeof raw === "object" && Array.isArray((raw as { steps?: unknown }).steps) ? ((raw as { steps: unknown[] }).steps as Record<string, unknown>[]) : [];
  const acting = new Set(actingSteps(d).map((s) => s.id));
  return list.flatMap((v) => {
    const id = typeof v.id === "string" ? v.id : "";
    const verdict = v.verdict === "fits" || v.verdict === "ask" || v.verdict === "outside" ? v.verdict : null;
    if (!acting.has(id) || !verdict) return [];
    return [{ id, verdict, reason: typeof v.reason === "string" ? v.reason.trim().slice(0, 300) : "" }];
  });
}

// The plan without the steps the guard would block, and the code steps
// that only made what they act with. A step stays when something else
// reads what it makes, or when the plan wouldn't check out without it.
export function leaveOut(d: AgentDefinition, verdicts: PurposeVerdict[]): { definition: AgentDefinition; dropped: { title: string; reason: string }[]; kept: PurposeVerdict[] } {
  let current = d;
  const dropped: { title: string; reason: string }[] = [];
  const kept: PurposeVerdict[] = [];
  for (const v of verdicts.filter((x) => x.verdict === "outside")) {
    const next = without(current, v.id);
    // The agent still does something for its owner: what it sends, writes
    // or pays is never all left out.
    if (next && !actingSteps(next).some((st) => st.kind === "action" && next.actions.find((a) => a.id === st.action)?.tool !== "memory.set")) {
      kept.push(v);
      continue;
    }
    const checked = next ? checkDefinition(next) : null;
    if (next && checked?.ok && !planProblems(checked.definition).length) {
      dropped.push({ title: current.steps.find((s) => s.id === v.id)!.title, reason: v.reason });
      current = checked.definition;
    } else kept.push(v);
  }
  return { definition: current, dropped, kept };
}

// The plan with one acting step taken out: whatever led to it goes where
// it went, and a code step that only made its arguments goes too.
function without(d: AgentDefinition, id: string): AgentDefinition | null {
  const step = d.steps.find((s) => s.id === id);
  if (!step || step.kind !== "action" || step.otherwise) return null;
  if (d.steps.some((s) => s.id !== id && s.inputs.some((k) => step.outputs.includes(k)))) return null;
  const gone = new Set([id]);
  // The code right before it that only made its arguments.
  const maker = d.steps.find((s) => s.kind === "code" && s.next === id && s.outputs.length > 0 && s.outputs.every((o) => step.inputs.includes(o) && !d.steps.some((x) => x.id !== id && x.inputs.includes(o))) && !s.tools.length);
  if (maker) gone.add(maker.id);
  const onward = step.next;
  const relink = (n: string | null) => (n !== null && gone.has(n) ? onward : n);
  if (d.steps[0] && gone.has(d.steps[0].id)) return null;
  const steps = d.steps
    .filter((s) => !gone.has(s.id))
    .map((s): AgentStep => {
      if (s.kind === "decision") return { ...s, outcomes: s.outcomes.map((o) => ({ ...o, next: relink(o.next) })) };
      if (s.kind === "action") return { ...s, next: relink(s.next), ...(s.otherwise !== undefined ? { otherwise: relink(s.otherwise ?? null) } : {}) };
      if (s.kind === "loop") return { ...s, next: relink(s.next), body: s.body };
      return { ...s, next: relink(s.next) };
    });
  if (steps.some((s) => s.kind === "loop" && gone.has(s.body))) return null;
  const used = new Set(steps.flatMap((s) => (s.kind === "action" ? [s.action] : [])));
  const tools = new Set(steps.flatMap((s) => (s.kind === "code" ? s.tools : [])));
  const actions = d.actions.filter((a) => used.has(a.id) || tools.has(a.tool));
  if (!steps.length || steps.some((s) => nextOf(s).some((n) => n !== null && gone.has(n)))) return null;
  return { ...d, steps, actions };
}
