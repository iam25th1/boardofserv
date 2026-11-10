import { ownedAgent } from "@/lib/agents/owned";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { auditForMaker } from "@/lib/agents/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The audit log of a maker's agent across every installation, for its
// maker only, with renters' data hidden: what ran, SERV's check, who
// approved it and its cost, never what it carried.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const before = new URL(req.url).searchParams.get("before");
  return Response.json({ audit: await auditForMaker(serverRuntime(), who.agent, before) });
}
