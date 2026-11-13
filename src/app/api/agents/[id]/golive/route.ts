import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { NotLive, putOnBoard, runForMaker } from "@/lib/agents/goLive";
import { cardsIn, updateCard } from "@/lib/agents/journey";
import { ownedAgent } from "@/lib/agents/owned";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { startHeal, summaryOf } from "@/lib/agents/build";
import { buildContext } from "@/lib/agents/context";
import { draftOf } from "@/lib/agents/store";
import type { Agent, User } from "@/lib/db/schema";
import type { ConnectAnswers } from "@/lib/journey";

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
  if (parsed.data.how === "run") {
    if (!answers) return Response.json({ error: "Connect it first." }, { status: 409 });
    if (card.card.live?.installationId) return Response.json({ error: "It's running for you already." }, { status: 409 });
  }
  const go = () => goLive(who.user, who.agent, parsed.data, answers);
  try {
    return Response.json(await go());
  } catch (err) {
    if (!(err instanceof NotLive)) throw err;
    // The review before going live held it: the build heals that like any
    // other failure, and once it passes goes live as it was asked to.
    const draft = err.diagnosis ? await draftOf(who.agent.id) : null;
    const ctx = draft ? buildContext(who.user, conversationId) : null;
    if (draft && ctx && err.diagnosis && startHeal(draft, err.diagnosis, ctx, { onTested: async (r) => void (r.status === "passed" && (await go().catch(() => null))) })) {
      return Response.json({ healing: true, agent: summaryOf(who.agent, { ...draft, buildState: "fixing" }) }, { status: 202 });
    }
    return Response.json({ error: err.message }, { status: err.status });
  }
}

// Go live as asked, and the card says so: running for the maker, or on the
// board. Neither choice does the other.
async function goLive(user: User, agent: Agent, how: z.infer<typeof Body>, answers: ConnectAnswers | undefined) {
  const rt = serverRuntime();
  const card = (await cardsIn(agent.sourceConversationId!)).filter((m) => m.card?.stage === "live").at(-1)!;
  if (how.how === "run") {
    const installation = await runForMaker(rt, user, agent, answers!);
    // An agent that pays with nothing in its allowance says so in the chat.
    await updateCard(card.id, { ...card.card!, live: { ...card.card!.live, installationId: installation.id } }, `It's running for you. ${installation.runs.join(" ")}${installation.allowanceWarning ? ` ${installation.allowanceWarning}` : ""}`.trim());
    return { installation };
  }
  const listing = await putOnBoard(rt, user, agent, { weeklyPrice: how.weeklyPrice, description: how.description });
  await updateCard(card.id, { ...card.card!, live: { ...card.card!.live, listed: true } }, card.card!.live?.installationId ? "It's running for you, and on the board for others to rent." : "It's on the board for others to rent.");
  return { listing };
}
