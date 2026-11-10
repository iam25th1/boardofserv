import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { answer, AnswerRefused, approvalDTO } from "@/lib/agents/runtime/approvals";
import { serverRuntime } from "@/lib/agents/runtime/context";

export const runtime = "nodejs";

const Body = z.object({ answer: z.string().min(1).max(80) });

// The owner answers one of their approvals; its job picks up where it paused.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!z.string().uuid().safeParse(params.id).success) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send your answer." }, { status: 400 });
  try {
    const done = await answer(serverRuntime(), user.id, params.id, parsed.data.answer);
    return Response.json({ approval: approvalDTO(done, null) });
  } catch (err) {
    if (err instanceof AnswerRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
