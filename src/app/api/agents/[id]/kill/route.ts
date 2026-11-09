import { z } from "zod";
import { eq } from "drizzle-orm";
import { agents } from "@/lib/db/schema";
import { ownedAgent } from "@/lib/agents/owned";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { makerDashboard } from "@/lib/market/dashboard";
import { startEverywhere, stopEverywhere } from "@/lib/safety/freeze";

export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["stop", "start"]), note: z.string().max(300).optional() });

// The maker's kill switch: stop the agent everywhere at once (every
// installation pauses and its renter is told; renewals wait; nothing new
// is rented), or start it again (the time it was stopped is added to every
// paid week). Its maker only.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say stop or start." }, { status: 400 });
  const rt = serverRuntime();
  const changed = parsed.data.action === "stop" ? await stopEverywhere(rt, who.agent, parsed.data.note?.trim() || null) : await startEverywhere(rt, who.agent);
  const [fresh] = await rt.db.select().from(agents).where(eq(agents.id, who.agent.id));
  return Response.json({ changed, dashboard: await makerDashboard(rt, fresh!) });
}
