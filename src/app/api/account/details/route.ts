import { eq } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export const runtime = "nodejs";

const Body = z.object({ on: z.boolean() });

// "Show details" on the agent page, kept for the signed-in maker: on, the
// page opens with the step graph, code, test bench and versions; off, with
// the plain view.
export async function PUT(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say on or off." }, { status: 400 });
  await db.update(users).set({ agentDetails: parsed.data.on, updatedAt: new Date() }).where(eq(users.id, user.id));
  return Response.json({ agentDetails: parsed.data.on });
}
