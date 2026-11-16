import { serverRuntime } from "@/lib/agents/runtime/context";
import { MAX_HOOK_BODY, takePost } from "@/lib/agents/runtime/hooks";
import { rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";

// An agent's private address (the catalog's Incoming webhook): a post
// starts a job with what was posted, JSON or text, as its trigger. No
// sign-in: the address itself is the secret, kept by its owner.
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const limited = rateLimited(req, "webhook");
  if (limited) return limited;
  const { key } = await ctx.params;
  const text = await req.text().catch(() => "");
  if (text.length > MAX_HOOK_BODY) return Response.json({ error: `A post is at most ${MAX_HOOK_BODY / 1000} KB.` }, { status: 413 });
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: its text.
  }
  const posted = await takePost(serverRuntime(), key, body);
  if ("refused" in posted) return Response.json({ error: posted.refused.error }, { status: posted.refused.status });
  return Response.json({ started: true, job: posted.jobId }, { status: 202 });
}
