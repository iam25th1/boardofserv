import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { cancelJob, CancelRefused } from "@/lib/agents/runtime/jobs";
import { jobFor } from "@/lib/agents/runtime/views";

export const runtime = "nodejs";

// Cancel, by the job's owner: one not started yet, or waiting for their
// answer, ends now; a running one stops where it is, keeping what it did.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  try {
    await cancelJob(rt, user.id, params.id);
  } catch (err) {
    if (err instanceof CancelRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  return Response.json({ job: await jobFor(rt, user.id, params.id) });
}
