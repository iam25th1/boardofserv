import { desc, eq } from "drizzle-orm";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { agentSketches, conversations } from "@/lib/db/schema";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  // Each conversation with its agent sketch's name, if it has one.
  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      sketchName: agentSketches.name,
    })
    .from(conversations)
    .leftJoin(agentSketches, eq(agentSketches.conversationId, conversations.id))
    .where(eq(conversations.userId, user.id))
    .orderBy(desc(conversations.updatedAt));
  return Response.json({ conversations: rows });
}

export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const [row] = await db.insert(conversations).values({ userId: user.id }).returning();
  return Response.json({ conversation: row && { ...row, sketchName: null } });
}
