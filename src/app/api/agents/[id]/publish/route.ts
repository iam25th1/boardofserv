import { builderOf } from "@/lib/agents/builderData";
import { ownedAgent } from "@/lib/agents/owned";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { draftOf, publishDraft } from "@/lib/agents/store";
import { offerVersion } from "@/lib/market/versions";

export const runtime = "nodejs";

// Publish the draft as a version that never changes again. It shows as "in
// testing" on the maker's own agents page until its maker lists it for
// rent; once listed, new renters get the newest version and those renting
// an older one are offered it (update or stay). Only a planned draft, not
// building, with every code step's code approved, can be published.
export async function POST(req: Request, { params }: { params: { id: string } }) {
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
  const published = await publishDraft(who.agent.id);
  if (!published) return Response.json({ error: "It could not be published just now. Try again." }, { status: 409 });
  await offerVersion(serverRuntime(), who.agent.id, published);
  return Response.json({ builder: await builderOf(who.agent, published) });
}
