import { notLetIn } from "@/lib/access";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { installationDTO, loadInstallation, ownedInstallation, stopOtherCopies } from "@/lib/agents/runtime/installations";

export const runtime = "nodejs";

// The owner stops the other copies of their own agent that run beside this
// one, each doing the same job; this one goes on.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const shut = notLetIn(user);
  if (shut) return shut;
  const rt = serverRuntime();
  const loaded = await ownedInstallation(rt, user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  if (loaded.installation.status === "stopped") return Response.json({ error: "This copy is stopped: keep one that runs instead." }, { status: 409 });
  const stopped = await stopOtherCopies(rt, loaded);
  return Response.json({ stopped, installation: await installationDTO(rt, (await loadInstallation(rt, loaded.installation.id))!) });
}
