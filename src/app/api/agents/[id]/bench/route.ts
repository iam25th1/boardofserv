import { z } from "zod";
import { builderOf } from "@/lib/agents/builderData";
import { ownedAgent } from "@/lib/agents/owned";
import { editableDraft, updateDraft } from "@/lib/agents/store";
import { BenchSchema } from "@/lib/agents/toolbox";

export const runtime = "nodejs";

const Body = z.object({ bench: BenchSchema });

// Save draft: the test bench's sample data is kept with the draft. On a
// published version this starts a new draft, which carries it.
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "The sample data isn't in a shape the bench can read." }, { status: 400 });
  const draft = await editableDraft(who.agent.id);
  const saved = await updateDraft(draft.id, { bench: parsed.data.bench });
  if (!saved) return Response.json({ error: "It could not be saved just now. Try again." }, { status: 409 });
  return Response.json({ builder: await builderOf(who.agent, saved) });
}
