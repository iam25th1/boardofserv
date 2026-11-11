import { notLetIn } from "@/lib/access";
import { looksRight } from "@/lib/agents/journey";
import { ownedAgent } from "@/lib/agents/owned";

export const runtime = "nodejs";

// Looks right, in the chat: the steps the maker looked at are built (each
// code step written and checked) and then tried on a sample, in the
// background; the chat's cards follow it (agents/journey.ts).
export async function POST(req: Request, route: { params: Promise<{ id: string }> }) {
  const params = await route.params;
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const shut = notLetIn(who.user);
  if (shut) return shut;
  const moved = await looksRight(who.user, who.agent);
  if ("refused" in moved) return Response.json({ error: moved.refused.error }, { status: moved.refused.status });
  return Response.json({ agent: moved.agent }, { status: 202 });
}
