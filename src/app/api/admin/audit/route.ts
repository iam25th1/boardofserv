import { serverRuntime } from "@/lib/agents/runtime/context";
import { auditForAdmin } from "@/lib/agents/audit";
import { requireAdmin } from "../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The whole audit log, for admins only: every installation's guarded
// actions, or one installation's or one agent's, a page at a time.
export async function GET(req: Request) {
  const who = await requireAdmin(req);
  if ("refused" in who) return who.refused;
  const q = new URL(req.url).searchParams;
  return Response.json({ audit: await auditForAdmin(serverRuntime(), { installationId: q.get("installation"), agentId: q.get("agent"), before: q.get("before") }) });
}
