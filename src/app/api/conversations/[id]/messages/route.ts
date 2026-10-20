import { and, asc, eq } from "drizzle-orm";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const convo = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, params.id), eq(conversations.userId, user.id)),
  });
  if (!convo) return Response.json({ error: "Not found" }, { status: 404 });
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, params.id))
    .orderBy(asc(messages.createdAt));
  return Response.json({ messages: rows });
}
