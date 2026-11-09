import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { installationDTO, ownedInstallation } from "@/lib/agents/runtime/installations";

export const runtime = "nodejs";

// One installation, for its owner only: a 404 for anyone else.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const loaded = await ownedInstallation(serverRuntime(), user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ installation: installationDTO(loaded) });
}
