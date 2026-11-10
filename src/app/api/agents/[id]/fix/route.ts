import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { startPlan, summaryOf } from "@/lib/agents/build";
import { buildContext, NOT_AVAILABLE } from "@/lib/agents/context";
import { ownedAgent } from "@/lib/agents/owned";
import { editableDraft } from "@/lib/agents/store";
import { loadSketch } from "@/lib/sketchStore";
import { refusal } from "@/lib/spend";

export const runtime = "nodejs";

const Body = z.object({ message: z.string().trim().min(1).max(2000) });

// Fix behaviour by chatting ("it ignored delivery time"): SERV changes the
// plan from what the maker says, in the background, and only the code steps
// whose job changed are written and reviewed again. On a published version
// this starts a new draft.
export async function POST(req: Request, route: { params: Promise<{ id: string }> }) {
  const params = await route.params;
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const shut = notLetIn(who.user);
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say what should change." }, { status: 400 });
  const ctx = buildContext(who.user, who.agent.sourceConversationId);
  if (!ctx) return Response.json({ error: NOT_AVAILABLE }, { status: 503 });
  const no = await refusal(who.user.id, { ownKey: ctx.ownKey });
  if (no) return Response.json(no, { status: 429 });

  const draft = await editableDraft(who.agent.id);
  if (!draft.definition) return Response.json({ error: "Plan it first." }, { status: 400 });
  const cid = who.agent.sourceConversationId;
  const sketch = cid ? await loadSketch(cid) : null;
  const history = cid
    ? await db.select({ role: messages.role, content: messages.content }).from(messages).where(eq(messages.conversationId, cid)).orderBy(asc(messages.createdAt))
    : [];
  const interview = sketch ?? { name: draft.definition.name, kind: "agent" as const, watches: null, when: null, how: null, tells: null, takes: null, does: null, gives: null, asking: null, live: false };
  if (!startPlan(draft, { interview, history, current: draft.definition, feedback: parsed.data.message }, ctx, "fix")) {
    return Response.json({ error: "It's being built already.", agent: summaryOf(who.agent, draft) }, { status: 409 });
  }
  return Response.json({ agent: summaryOf(who.agent, { ...draft, buildState: "fixing", buildNote: null }) }, { status: 202 });
}
