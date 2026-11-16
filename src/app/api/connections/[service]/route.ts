import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { connectService, ConnectRefused } from "@/lib/connections/connect";

export const runtime = "nodejs";

const Body = z.object({ fields: z.record(z.string().max(40), z.string().max(2000)) });

// Connect a service of the catalog with what the owner pastes (a key, a
// token, a webhook's address, and an account or shop where it needs one):
// checked once with the service, then kept encrypted and never shown
// again. The owner sees whose it is. Disconnecting is
// DELETE /api/connections?provider=<service>.
export async function POST(req: Request, ctx: { params: Promise<{ service: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const { service } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Paste what the service gave you." }, { status: 400 });
  try {
    const { label } = await connectService(serverRuntime(), user.id, service, parsed.data.fields);
    return Response.json({ connected: true, label });
  } catch (err) {
    if (err instanceof ConnectRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
