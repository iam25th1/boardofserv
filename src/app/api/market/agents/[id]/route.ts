import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { agentPage } from "@/lib/market/listings";
import { rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An agent's page on the board, for anyone: what it does and how, in plain
// words. Never its code or prompts.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const limited = rateLimited(req, "read");
  if (limited) return limited;
  const user = await getUserFromRequest(req).catch(() => null);
  const page = await agentPage(serverRuntime(), params.id, user?.id ?? null);
  if (!page) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ agent: page });
}
