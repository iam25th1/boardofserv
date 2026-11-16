import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { connectService, ConnectRefused } from "@/lib/connections/connect";

export const runtime = "nodejs";

const Body = z.object({ token: z.string().trim().min(10).max(400) });

// Connect Typeform: the owner pastes a personal token. It is the catalog's
// Typeform entry, connected like any other service (connections/
// connect.ts): tried once against Typeform (whose account it is), then
// kept encrypted in the vault and never shown again; the owner sees the
// account's name and when it was connected. Disconnecting is
// DELETE /api/connections?provider=typeform.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Paste your Typeform personal token." }, { status: 400 });
  try {
    const { label } = await connectService(serverRuntime(), user.id, "typeform", { token: parsed.data.token });
    return Response.json({ connected: true, label });
  } catch (err) {
    if (err instanceof ConnectRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
