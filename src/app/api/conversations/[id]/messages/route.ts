import { and, asc, eq } from "drizzle-orm";
import { getUserFromRequest } from "@/lib/auth-route";
import { fixDashes } from "@/lib/dashes";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";
import { liveHelperFor } from "@/lib/helpers";
import { loadSketch } from "@/lib/sketchStore";
import { settle, summaryOf } from "@/lib/agents/build";
import { agentForConversation, currentVersion } from "@/lib/agents/store";

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
  // Replies stored before em dashes were taken out are shown without them too.
  const shown = rows.map((m) => (m.role === "assistant" ? { ...m, content: fixDashes(m.content) } : m));
  // The conversation's agent sketch comes with it, or null when there is
  // none, the helper published from it while that is on the board, and the
  // agent built from it, as its dock shows it.
  const agent = await agentForConversation(params.id);
  const version = agent && agent.ownerUserId === user.id ? await currentVersion(agent.id) : null;
  return Response.json({
    messages: shown,
    sketch: await loadSketch(params.id),
    published: await liveHelperFor(params.id),
    agent: agent && version ? summaryOf(agent, await settle(version)) : null,
  });
}
