import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { NotLive, putOnBoard, runForMaker } from "@/lib/agents/goLive";
import { cardsIn, updateCard } from "@/lib/agents/journey";
import { ownedAgent } from "@/lib/agents/owned";
import { serverRuntime } from "@/lib/agents/runtime/context";

export const runtime = "nodejs";

const Body = z.discriminatedUnion("how", [z.object({ how: z.literal("run") }), z.object({ how: z.literal("board"), weeklyPrice: z.string().max(20), description: z.string().max(600) })]);

// Go live, from the chat's last card: "Run it for me" starts it for the
// maker with what they gave at Connect; "Put it on the board" lists it for
// others to rent. Either way the version it runs is published first, with
// its code review (agents/goLive.ts).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const shut = notLetIn(who.user);
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say how it goes live: run it for you, or put it on the board." }, { status: 400 });
  const conversationId = who.agent.sourceConversationId;
  const cards = conversationId ? await cardsIn(conversationId) : [];
  const card = cards.filter((m) => m.card?.stage === "live").at(-1);
  const answers = cards.filter((m) => m.card?.stage === "connect" && m.card.answers).at(-1)?.card?.answers;
  if (!card?.card) return Response.json({ error: "Connect it first." }, { status: 409 });
  const rt = serverRuntime();
  try {
    if (parsed.data.how === "run") {
      if (!answers) return Response.json({ error: "Connect it first." }, { status: 409 });
      if (card.card.live?.installationId) return Response.json({ error: "It's running for you already." }, { status: 409 });
      const installation = await runForMaker(rt, who.user, who.agent, answers);
      await updateCard(card.id, { ...card.card, live: { ...card.card.live, installationId: installation.id } }, `It's running for you. ${installation.runs.join(" ")}`.trim());
      return Response.json({ installation });
    }
    const listing = await putOnBoard(rt, who.user, who.agent, { weeklyPrice: parsed.data.weeklyPrice, description: parsed.data.description });
    await updateCard(card.id, { ...card.card, live: { ...card.card.live, listed: true } }, card.card.live?.installationId ? "It's running for you, and on the board for others to rent." : "It's on the board for others to rent.");
    return Response.json({ listing });
  } catch (err) {
    if (err instanceof NotLive) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
