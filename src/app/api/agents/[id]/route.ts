import { builderOf } from "@/lib/agents/builderData";
import { settle, summaryOf } from "@/lib/agents/build";
import { ownedAgent } from "@/lib/agents/owned";
import { currentVersion } from "@/lib/agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An agent, for its maker only: as the dock shows it while it builds, or
// with ?view=builder everything the builder shows (its code included).
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const version = await currentVersion(who.agent.id);
  if (!version) return Response.json({ error: "Not found" }, { status: 404 });
  const settled = await settle(version);
  if (new URL(req.url).searchParams.get("view") === "builder") return Response.json({ builder: await builderOf(who.agent, settled) });
  return Response.json({ agent: summaryOf(who.agent, settled) });
}
