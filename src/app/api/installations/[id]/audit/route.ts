import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { ownedInstallation } from "@/lib/agents/runtime/installations";
import { auditForRenter } from "@/lib/agents/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The audit log of an installation's guarded actions, for its owner only
// (a 404 for anyone else), newest first, a page at a time.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const loaded = await ownedInstallation(rt, user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  const before = new URL(req.url).searchParams.get("before");
  return Response.json({ audit: await auditForRenter(rt, loaded.installation.id, before) });
}
