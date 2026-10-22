import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { agentSketches, conversations, publishedHelpers } from "@/lib/db/schema";
import { liveHelperFor } from "@/lib/helpers";

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
  // The popover shows the agent's name once there is a sketch, so renaming
  // renames the agent too. The next reply sees the new name in its history.
  const [sketch] = await db
    .update(agentSketches)
    .set({ name: parsed.data.title, updatedAt: new Date() })
    .where(eq(agentSketches.conversationId, params.id))
    .returning({ name: agentSketches.name });
  const live = await liveHelperFor(params.id);
  return Response.json({ conversation: row && { ...row, sketchName: sketch?.name ?? null, publishedSlug: live?.slug ?? null } });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!(await owned(user.id, params.id))) return Response.json({ error: "Not found" }, { status: 404 });
  // A helper published from it comes off the board with it: without the
  // conversation, the maker would have nowhere to take it down from.
  await db.transaction(async (tx) => {
    await tx
      .update(publishedHelpers)
      .set({ unpublishedAt: new Date() })
      .where(and(eq(publishedHelpers.sourceConversationId, params.id), isNull(publishedHelpers.unpublishedAt)));
    await tx.delete(conversations).where(eq(conversations.id, params.id));
  });
  return Response.json({ ok: true });
}
