import { notLetIn } from "@/lib/access";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { ControlRefused, installationDTO, loadInstallation, ownedInstallation, switchVersion } from "@/lib/agents/runtime/installations";

export const runtime = "nodejs";

// The owner switches their own copy to the newest version of their agent,
// keeping its answers; one that asks something new is set up from its page.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const shut = notLetIn(user);
  if (shut) return shut;
  const rt = serverRuntime();
  const loaded = await ownedInstallation(rt, user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    await switchVersion(rt, loaded);
  } catch (err) {
    if (err instanceof ControlRefused) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
  return Response.json({ installation: await installationDTO(rt, (await loadInstallation(rt, loaded.installation.id))!) });
}
