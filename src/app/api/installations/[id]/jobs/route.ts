import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { ownedInstallation } from "@/lib/agents/runtime/installations";
import { jobsOfInstallation } from "@/lib/agents/runtime/views";

export const runtime = "nodejs";

// An installation's recent jobs, for its owner only.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const loaded = await ownedInstallation(rt, user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ jobs: await jobsOfInstallation(rt, loaded.installation.id, 20) });
}
