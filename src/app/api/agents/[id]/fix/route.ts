import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { changePlan } from "@/lib/agents/change";
import { ownedAgent } from "@/lib/agents/owned";

export const runtime = "nodejs";

// What changes: the plan, from what the maker says ("it ignored delivery
// time"), or one step on hold, which SERV writes again ("Fix this").
const Body = z.union([z.object({ message: z.string().trim().min(1).max(2000) }), z.object({ step: z.string().trim().min(1).max(40) })]);

// Fix behaviour by saying what went wrong, or fix a step on hold with no
// typing: the same path the chat takes for a change asked there
// (agents/change.ts). On a published version this starts a new draft.
export async function POST(req: Request, route: { params: Promise<{ id: string }> }) {
  const params = await route.params;
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const shut = notLetIn(who.user);
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say what should change." }, { status: 400 });
  const changed = await changePlan(who.user, who.agent, parsed.data);
  if (changed.kind === "refused") return Response.json(changed.body, { status: changed.status });
  if (changed.kind === "unplanned") return Response.json({ error: changed.error }, { status: 400 });
  if (changed.kind === "busy") return Response.json({ error: changed.error, agent: changed.agent }, { status: 409 });
  return Response.json({ agent: changed.agent }, { status: 202 });
}
