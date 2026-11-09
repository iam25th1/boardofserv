import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { settle, summaryOf } from "@/lib/agents/build";
import { agentById, currentVersion } from "@/lib/agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An agent as its maker's dock shows it, while it builds. Only its maker:
// anyone else is told it isn't there.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!z.string().uuid().safeParse(params.id).success) return Response.json({ error: "Not found" }, { status: 404 });
  const agent = await agentById(params.id);
  if (!agent || agent.ownerUserId !== user.id) return Response.json({ error: "Not found" }, { status: 404 });
  const version = await currentVersion(agent.id);
  if (!version) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ agent: summaryOf(agent, await settle(version)) });
}
