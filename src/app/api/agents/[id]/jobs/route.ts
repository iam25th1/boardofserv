import { ownedAgent } from "@/lib/agents/owned";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { jobsOfAgent } from "@/lib/agents/runtime/views";

export const runtime = "nodejs";

// The maker's view of how their agent runs, on every installation: their
// own jobs in full, everyone else's without the owner's data.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  return Response.json({ jobs: await jobsOfAgent(serverRuntime(), who.user.id, who.agent.id) });
}
