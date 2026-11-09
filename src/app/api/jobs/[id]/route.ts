import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { jobFor } from "@/lib/agents/runtime/views";

export const runtime = "nodejs";

// One job and its steps: in full for its owner, without the owner's data
// for the agent's maker, a 404 for anyone else.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const job = await jobFor(serverRuntime(), user.id, params.id);
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ job });
}
