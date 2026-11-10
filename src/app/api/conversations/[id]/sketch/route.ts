import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { conversations } from "@/lib/db/schema";
import { liveHelperFor } from "@/lib/helpers";
import { SKETCH_KINDS } from "@/lib/sketchFields";
import { chooseKind } from "@/lib/sketchStore";

export const runtime = "nodejs";

const Patch = z.object({ kind: z.enum(SKETCH_KINDS) });

// The maker switches the kind of the agent sketched in their conversation
// (answer, watcher, digest or helper). From then on the plan keeps it. A
// helper that is on the board keeps its kind until it is taken down.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const convo = await db.query.conversations.findFirst({ where: and(eq(conversations.id, params.id), eq(conversations.userId, user.id)) });
  if (!convo) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Pick answer, watcher, digest or helper." }, { status: 400 });
  if (await liveHelperFor(params.id)) return Response.json({ error: "Take it off the board first." }, { status: 409 });
  const sketch = await chooseKind(params.id, parsed.data.kind);
  if (!sketch) return Response.json({ error: "There is no sketch here yet." }, { status: 404 });
  return Response.json({ sketch });
}
