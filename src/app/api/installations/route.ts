import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { installationDTO, installationsOf } from "@/lib/agents/runtime/installations";

export const runtime = "nodejs";

// The signed-in owner's installations, newest first.
export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const list = await installationsOf(serverRuntime(), user.id);
  return Response.json({ installations: list.map(installationDTO) });
}
