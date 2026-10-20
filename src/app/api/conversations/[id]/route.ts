import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { conversations } from "@/lib/db/schema";

export const runtime = "nodejs";

const Patch = z.object({ title: z.string().trim().min(1).max(200) });

async function owned(userId: string, id: string) {
  return db.query.conversations.findFirst({
    where: and(eq(conversations.id, id), eq(conversations.userId, userId)),
  });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!(await owned(user.id, params.id))) return Response.json({ error: "Not found" }, { status: 404 });

  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A title is required" }, { status: 400 });
  const [row] = await db
    .update(conversations)
    .set({ title: parsed.data.title, updatedAt: new Date() })
    .where(eq(conversations.id, params.id))
    .returning();
  return Response.json({ conversation: row });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!(await owned(user.id, params.id))) return Response.json({ error: "Not found" }, { status: 404 });
  await db.delete(conversations).where(eq(conversations.id, params.id));
  return Response.json({ ok: true });
}
