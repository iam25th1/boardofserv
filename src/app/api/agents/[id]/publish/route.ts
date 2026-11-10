import { builderOf } from "@/lib/agents/builderData";
import { ownedAgent } from "@/lib/agents/owned";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { draftOf, publishDraft } from "@/lib/agents/store";
import { offerVersion } from "@/lib/market/versions";
import { REVIEW_BLOCKED, REVIEW_DOWN, vetVersion } from "@/lib/agents/publish";
import { activeFreeze } from "@/lib/safety/freeze";

export const runtime = "nodejs";

// Publish the draft as a version that never changes again. It shows as "in
// testing" on the maker's own agents page until its maker lists it for
// rent; once listed, new renters get the newest version and those renting
// an older one are offered it (update or stay). Only a planned draft, not
// building, with every code step's code approved and a code review with no
// blocking finding, can be published.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const draft = await draftOf(who.agent.id);
  if (!draft) return Response.json({ error: "There's no draft to publish: change something first." }, { status: 409 });
  if (!draft.definition) return Response.json({ error: "Plan it first." }, { status: 409 });
  if (draft.buildState !== "idle") return Response.json({ error: "Wait for it to finish building." }, { status: 409 });
  const waiting = draft.definition.steps.filter((s) => s.kind === "code" && draft.code[s.id]?.status !== "approved");
  if (waiting.length) {
    return Response.json({ error: `${waiting.map((s) => `"${s.title}"`).join(", ")} ${waiting.length === 1 ? "still needs" : "still need"} approved code.` }, { status: 409 });
  }
  const rt = serverRuntime();
  // A frozen agent or maker publishes nothing.
  const frozen = (await activeFreeze(rt, { agentId: who.agent.id, makerId: who.user.id })) ?? null;
  if (frozen) return Response.json({ error: `It can't be published now: boardofserv froze it. ${frozen.reason}` }, { status: 409 });
  // The code review: nothing unreviewed or with a blocking finding goes out.
  const review = await vetVersion(rt, who.user, draft);
  if (review.status === "unreviewed") return Response.json({ error: REVIEW_DOWN, review }, { status: 503 });
  if (review.status === "blocked") return Response.json({ error: REVIEW_BLOCKED, review, builder: await builderOf(who.agent, { ...draft, review }) }, { status: 409 });
  const published = await publishDraft(who.agent.id);
  if (!published) return Response.json({ error: "It could not be published just now. Try again." }, { status: 409 });
  await offerVersion(rt, who.agent.id, published);
  return Response.json({ builder: await builderOf(who.agent, published) });
}
