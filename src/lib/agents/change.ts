import "server-only";
import type { Agent, User } from "../db/schema";
import type { AgentSummaryDTO } from "../types";
import { refusal } from "../spend";
import { planInputFor, startPlan, startRewrite, summaryOf } from "./build";
import { buildContext, NOT_AVAILABLE } from "./context";
import { editableDraft } from "./store";

// Changing an agent's plan from what its maker says, the one way it is done
// wherever they say it: "Change the plan" and "Fix this" on the agent's
// page, and asking for a change in the chat. SERV changes the plan in the
// background, and only the code steps whose job changed are written and
// reviewed again; on a published version this starts a new draft. "Fix
// this" on a step on hold has SERV write that step's code again instead.

export type Changed =
  | { kind: "started"; agent: AgentSummaryDTO }
  | { kind: "busy"; agent: AgentSummaryDTO; error: string }
  | { kind: "refused"; status: number; body: unknown; error: string }
  | { kind: "unplanned"; error: string };

const BUSY = "It's being built already.";

export async function changePlan(user: User, agent: Agent, change: { message: string } | { step: string }): Promise<Changed> {
  const ctx = buildContext(user, agent.sourceConversationId);
  if (!ctx) return { kind: "refused", status: 503, body: { error: NOT_AVAILABLE }, error: NOT_AVAILABLE };
  const no = await refusal(user.id, { ownKey: ctx.ownKey });
  if (no) return { kind: "refused", status: 429, body: no, error: no.error };

  const draft = await editableDraft(agent.id);
  if (!draft.definition) return { kind: "unplanned", error: "Plan it first." };
  if ("step" in change) {
    if (!startRewrite(draft, change.step, ctx)) return { kind: "busy", agent: summaryOf(agent, draft), error: BUSY };
    return { kind: "started", agent: summaryOf(agent, { ...draft, buildState: "writing", buildNote: null }) };
  }
  if (!startPlan(draft, await planInputFor(agent.sourceConversationId, draft.definition, change.message), ctx, "fix")) {
    return { kind: "busy", agent: summaryOf(agent, draft), error: BUSY };
  }
  return { kind: "started", agent: summaryOf(agent, { ...draft, buildState: "fixing", buildNote: null }) };
}
