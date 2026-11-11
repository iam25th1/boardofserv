import { and, asc, count, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { conversations, messages, rentals } from "@/lib/db/schema";
import { startPlan, summaryOf } from "@/lib/agents/build";
import { buildContext, NOT_AVAILABLE } from "@/lib/agents/context";
import { agentForConversation, agentsOf, createAgent, editableDraft, versionsOf } from "@/lib/agents/store";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { listingOf } from "@/lib/market/listings";
import { describedEnough } from "@/lib/sketchFields";
import { makeIt } from "@/lib/agents/journey";
import { loadSketch } from "@/lib/sketchStore";
import { refusal } from "@/lib/spend";

export const runtime = "nodejs";

// review: Make it in the chat, which stops once the steps are there for
// the maker to look at (agents/journey.ts).
const Body = z.object({ conversationId: z.string().uuid(), review: z.boolean().optional() });

// Plan the agent sketched in a conversation: SERV turns the interview into
// steps in the background, then its code is written and reviewed. The first
// time makes the agent; again plans its draft afresh. Answers at once with
// the agent as its dock shows it, still planning.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const shut = notLetIn(user);
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Which conversation?" }, { status: 400 });
  const { conversationId } = parsed.data;
  const convo = await db.query.conversations.findFirst({ where: and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)) });
  if (!convo) return Response.json({ error: "Not found" }, { status: 404 });
  if (parsed.data.review) {
    const moved = await makeIt(user, conversationId);
    if ("refused" in moved) return Response.json({ error: moved.refused.error }, { status: moved.refused.status });
    return Response.json({ agent: moved.agent }, { status: 202 });
  }

  const sketch = await loadSketch(conversationId);
  if (!sketch || !describedEnough(sketch)) {
    return Response.json({ error: "Finish describing the agent first." }, { status: 400 });
  }
  const ctx = buildContext(user, conversationId);
  if (!ctx) return Response.json({ error: NOT_AVAILABLE }, { status: 503 });
  const no = await refusal(user.id, { ownKey: ctx.ownKey });
  if (no) return Response.json(no, { status: 429 });

  const existing = await agentForConversation(conversationId);
  const { agent, draft } = existing ? { agent: existing, draft: await editableDraft(existing.id) } : await createAgent({ ownerUserId: user.id, conversationId, name: sketch.name ?? "Unnamed agent" });
  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  if (!startPlan(draft, { interview: sketch, history }, ctx)) {
    return Response.json({ error: "It's being built already.", agent: summaryOf(agent, draft) }, { status: 409 });
  }
  return Response.json({ agent: summaryOf(agent, { ...draft, buildState: "planning", buildNote: null }) }, { status: 202 });
}

// The maker's own agents, newest first: each one's latest version, whether
// a published version is in testing, and whether it is on the board and
// how many rent it. Never anyone else's.
export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const mine = await agentsOf(user.id);
  const agents = await Promise.all(
    mine.map(async (a) => {
      const versions = await versionsOf(a.id);
      const published = versions.find((v) => v.state === "published");
      return {
        id: a.id,
        name: versions[0]?.definition?.name ?? a.name,
        version: versions[0]?.number ?? 1,
        testing: published ? published.number : null,
        draft: versions.some((v) => v.state === "draft"),
        steps: versions[0]?.definition?.steps.length ?? 0,
        updatedAt: a.updatedAt.toISOString(),
        board: await boardOf(a.id),
      };
    }),
  );
  return Response.json({ agents });
}

async function boardOf(agentId: string): Promise<{ renters: number } | null> {
  const rt = serverRuntime();
  const listing = await listingOf(rt, agentId);
  if (!listing?.listed) return null;
  const [n] = await rt.db.select({ n: count() }).from(rentals).where(and(eq(rentals.agentId, agentId), ne(rentals.status, "ended")));
  return { renters: n?.n ?? 0 };
}
