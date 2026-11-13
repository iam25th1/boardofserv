import { ownedAgent } from "@/lib/agents/owned";
import { stopBuild, summaryOf } from "@/lib/agents/build";
import { draftOf } from "@/lib/agents/store";

export const runtime = "nodejs";

// Stop, in the chat, while its steps are worked out, built, tried or
// fixed: the work stops where it is (its model calls aborted), what was
// done is kept, and the maker can change what they like and send it again.
export async function POST(req: Request, route: { params: Promise<{ id: string }> }) {
  const params = await route.params;
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const draft = await draftOf(who.agent.id);
  if (!draft) return Response.json({ error: "Nothing is being built." }, { status: 409 });
  const stopped = await stopBuild(draft.id);
  const now = (await draftOf(who.agent.id)) ?? draft;
  return Response.json({ stopped, agent: summaryOf(who.agent, now) });
}
