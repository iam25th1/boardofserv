import { and, count, eq } from "drizzle-orm";
import { getUserFromRequest } from "@/lib/auth-route";
import { approvalsOf } from "@/lib/agents/runtime/approvals";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { agentApprovals } from "@/lib/db/schema";

export const runtime = "nodejs";

// The signed-in owner's approvals, the waiting ones first; with ?count=1,
// only how many wait (for the top bar's badge).
export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  if (new URL(req.url).searchParams.get("count") === "1") {
    const [row] = await rt.db
      .select({ n: count() })
      .from(agentApprovals)
      .where(and(eq(agentApprovals.ownerUserId, user.id), eq(agentApprovals.status, "pending")));
    return Response.json({ pending: row?.n ?? 0 });
  }
  return Response.json({ approvals: await approvalsOf(rt, user.id) });
}
