import { z } from "zod";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { adminSafety } from "@/lib/safety/admin";
import { lift } from "@/lib/safety/freeze";
import { requireAdmin } from "../../guard";

export const runtime = "nodejs";

const Body = z.object({ reason: z.string().trim().min(3).max(300) });

// An admin lifts a freeze, saying why. What it paused starts again where
// nothing else holds it. Admins only.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const who = await requireAdmin(req);
  if ("refused" in who) return who.refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say why it's lifted (a few words at least)." }, { status: 400 });
  const rt = serverRuntime();
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return Response.json({ error: "Not found" }, { status: 404 });
  const done = await lift(rt, who.admin, params.id, parsed.data.reason);
  if (!done) return Response.json({ error: "It isn't frozen." }, { status: 409 });
  return Response.json({ safety: await adminSafety(rt) });
}
