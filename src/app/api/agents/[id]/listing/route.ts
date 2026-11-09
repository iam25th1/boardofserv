import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { builderOf } from "@/lib/agents/builderData";
import { ownedAgent } from "@/lib/agents/owned";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { currentVersion } from "@/lib/agents/store";
import { setListing } from "@/lib/market/listings";
import { activeFreeze } from "@/lib/safety/freeze";
import { screenListing } from "@/lib/safety/moderation";
import { paymentsConfig } from "@/lib/payments/config";
import { priceProblem } from "@/lib/payments/uses";

export const runtime = "nodejs";

// USDC minor units, as strings of digits ("0" for free, or for no fee).
const Body = z.object({
  weeklyPrice: z.string().regex(/^\d{1,78}$/),
  jobFee: z.string().regex(/^\d{1,78}$/),
  listed: z.boolean(),
  // The default weekly model budget for each renter (USDC minor units),
  // and whether renters pay their jobs' model cost on top of the fee.
  modelBudget: z.string().regex(/^\d{1,78}$/).optional(),
  modelShare: z.boolean().optional(),
});

// The maker puts their agent's newest published version on the board for
// rent, changes its price, or takes it off. Renting now keep their price.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const shut = notLetIn(who.user);
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send a weekly price and a fee per job, in USDC." }, { status: 400 });
  const weeklyPrice = BigInt(parsed.data.weeklyPrice);
  const jobFee = BigInt(parsed.data.jobFee);
  // A price needs payments on; free stays possible without them.
  if ((weeklyPrice > 0n || jobFee > 0n) && !paymentsConfig().enabled) return Response.json({ error: "Payments aren't on here yet, so it can only be listed free." }, { status: 409 });
  for (const amount of [weeklyPrice, jobFee]) {
    const problem = amount > 0n ? priceProblem("USDC", amount) : null;
    if (problem) return Response.json({ error: problem }, { status: 400 });
  }
  const rt = serverRuntime();
  const frozen = await activeFreeze(rt, { agentId: who.agent.id, makerId: who.user.id });
  if (frozen && parsed.data.listed) return Response.json({ error: `It can't go on the board now: boardofserv froze it. ${frozen.reason}` }, { status: 409 });
  const listing = await setListing(rt, who.agent, { weeklyPrice, jobFee, listed: parsed.data.listed, modelBudget: parsed.data.modelBudget ? BigInt(parsed.data.modelBudget) : undefined, modelShare: parsed.data.modelShare });
  if (!listing) return Response.json({ error: "Publish a version first: renters get a published version, which never changes." }, { status: 409 });
  // Before it goes public, SERV screens it; anything it holds waits for an admin.
  if (parsed.data.listed) await screenListing(rt, who.user, who.agent.id);
  return Response.json({ builder: await builderOf(who.agent, (await currentVersion(who.agent.id))!) });
}
