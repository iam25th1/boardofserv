import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { connectionsOf } from "@/lib/connections/vault";

export const runtime = "nodejs";

// The signed-in owner's connections (never a secret), and which services
// can be connected here at all.
export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  return Response.json({
    connections: await connectionsOf(rt, user.id),
    available: { telegram: Boolean(rt.services.telegramToken), google: Boolean(rt.services.google) },
  });
}
