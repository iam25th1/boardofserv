import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { marketRefusal } from "@/lib/market/limits";
import { screenOffer } from "@/lib/safety/moderation";
import { eq } from "drizzle-orm";
import { agentListings, agents, agentVersions } from "@/lib/db/schema";
import { makeOffer, NOTE_MAX, requestPage, RequestRefused } from "@/lib/market/requests";
import { paymentsConfig } from "@/lib/payments/config";
import { priceProblem } from "@/lib/payments/uses";

export const runtime = "nodejs";

const Body = z.object({
  agentId: z.string().max(64),
  note: z.string().max(NOTE_MAX * 2).default(""),
  // USDC minor units ("0" for free, or no fee).
  weeklyPrice: z.string().regex(/^\d{1,78}$/),
  jobFee: z.string().regex(/^\d{1,78}$/).default("0"),
});

// A maker offers one of their published agents for a request, with a note
// and a price (offering again changes it).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const shut = await marketRefusal(rt, user, { counted: true, spends: true });
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Pick one of your agents, and say its price a week in USDC." }, { status: 400 });
  const weeklyPrice = BigInt(parsed.data.weeklyPrice);
  const jobFee = BigInt(parsed.data.jobFee);
  if ((weeklyPrice > 0n || jobFee > 0n) && !paymentsConfig().enabled) return Response.json({ error: "Payments aren't on here yet, so it can only be offered free." }, { status: 409 });
  for (const amount of [weeklyPrice, jobFee]) {
    const problem = amount > 0n ? priceProblem("USDC", amount) : null;
    if (problem) return Response.json({ error: problem }, { status: 400 });
  }
  try {
    const offer = await makeOffer(rt, user.id, params.id, { agentId: parsed.data.agentId, note: parsed.data.note, weeklyPrice, jobFee });
    // SERV screens it before it goes public; what it holds waits for an admin.
    const [a] = await rt.db
      .select({ name: agents.name, definition: agentVersions.definition })
      .from(agents)
      .leftJoin(agentListings, eq(agentListings.agentId, agents.id))
      .leftJoin(agentVersions, eq(agentVersions.id, agentListings.versionId))
      .where(eq(agents.id, offer.agentId));
    await screenOffer(rt, user, offer.id, offer.note, { name: a?.name ?? "", does: a?.definition?.job.does ?? "" });
  } catch (err) {
    if (err instanceof RequestRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  return Response.json((await requestPage(rt, params.id, user.id))!, { status: 201 });
}
