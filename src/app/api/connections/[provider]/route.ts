import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { CONNECTION_PROVIDERS, type ConnectionProvider } from "@/lib/db/schema";
import { disconnect } from "@/lib/connections/vault";

export const runtime = "nodejs";

// The owner disconnects a service: revoked where the service allows it,
// forgotten here, and every installation that needs it paused.
export async function DELETE(req: Request, { params }: { params: { provider: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!(CONNECTION_PROVIDERS as readonly string[]).includes(params.provider)) return Response.json({ error: "Not found" }, { status: 404 });
  const rt = serverRuntime();
  const done = await disconnect(rt, user.id, params.provider as ConnectionProvider);
  if (!done) return Response.json({ error: "It isn't connected." }, { status: 404 });
  return Response.json(done);
}
