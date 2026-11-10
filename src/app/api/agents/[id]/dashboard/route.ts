import { ownedAgent } from "@/lib/agents/owned";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { makerDashboard } from "@/lib/market/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The maker's dashboard for their agent on the board: renters, earnings
// by week, how renters' jobs went and where they failed, and versions.
// Never a renter's data.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  return Response.json({ dashboard: await makerDashboard(serverRuntime(), who.agent) });
}
